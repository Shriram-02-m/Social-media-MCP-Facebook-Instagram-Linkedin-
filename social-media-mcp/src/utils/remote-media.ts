import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { matchesMediaSignature } from "../storage/scheduled-images.js";

// Fetches user-supplied remote media for the remote MCP endpoint. A public MCP
// client cannot send local file paths to Render, so image/video/PDF inputs may
// be public HTTPS URLs. The fetcher rejects non-HTTPS URLs, credentials,
// loopback/private/reserved addresses, oversized bodies, and re-validates every
// redirect. DNS is resolved once and pinned into the TLS connection so a second
// lookup cannot rebind the host to an internal address.

export interface RemoteMediaLimits {
  maxBytes: number;
  timeoutMs: number;
  allowedContentTypes: readonly string[];
  maxRedirects?: number;
}

export interface RemoteMedia {
  bytes: Buffer;
  contentType: string;
  extension: string;
  finalUrl: string;
}

interface ResolvedTarget {
  url: URL;
  hostname: string;
  address: string;
  family: number;
}

const extensionByContentType: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "application/pdf": ".pdf",
};

function ipv4ToNumber(address: string): number {
  const parts = address.split(".").map(Number);
  return (((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]!) >>> 0;
}

const ipv4Ranges: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  return ipv4Ranges.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToNumber(base) & mask);
  });
}

function ipv4FromMappedIpv6(value: string): string | undefined {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (!hex) return undefined;
  const high = Number.parseInt(hex[1]!, 16);
  const low = Number.parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

export function isPrivateIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true;
  const value = address.toLowerCase();
  if (value === "::" || value === "::1") return true;
  const mapped = ipv4FromMappedIpv6(value);
  if (mapped) return isPrivateIpv4(mapped);
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (value.startsWith("2001:db8:")) return true; // documentation
  if (value.startsWith("2001:10:") || value.startsWith("2001:20:")) return true; // ORCHID
  if (value.startsWith("2002:")) {
    // 6to4 embeds an IPv4 address in the next 32 bits.
    const parts = value.split(":");
    if (parts.length >= 3) {
      const high = Number.parseInt(parts[1]!, 16);
      const low = Number.parseInt(parts[2]!, 16);
      if (Number.isFinite(high) && Number.isFinite(low)) {
        return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
      }
    }
    return true;
  }
  if (value.startsWith("64:ff9b:") || value.startsWith("100:")) return true; // NAT64 / discard
  return false;
}

function hostnameWithoutBrackets(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "");
}

export async function resolvePublicHttpsUrl(raw: string): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Media URL must be a valid absolute URL.");
  }
  if (url.protocol !== "https:") throw new Error("Media URLs must use HTTPS.");
  if (url.username || url.password) throw new Error("Media URLs must not contain embedded credentials.");
  if (!url.hostname) throw new Error("Media URL must include a hostname.");
  const hostname = hostnameWithoutBrackets(url.hostname).toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("Media URL must be publicly reachable.");
  }
  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await dnsLookup(hostname, { all: true, verbatim: true });
  if (!addresses.length) throw new Error("Media URL hostname did not resolve.");
  for (const entry of addresses) {
    if (isPrivateIpAddress(entry.address)) {
      throw new Error("Media URL must not resolve to a private, loopback, or reserved address.");
    }
  }
  const first = addresses[0]!;
  return {
    url,
    hostname,
    address: first.address,
    family: first.family,
  };
}

interface OneResponse {
  status: number;
  location?: string;
  contentType?: string;
  bytes: Buffer;
}

function requestOnce(target: ResolvedTarget, limits: RemoteMediaLimits): Promise<OneResponse> {
  return new Promise((resolve, reject) => {
    const pinnedLookup: LookupFunction = (_hostname, _options, callback) => {
      callback(null, target.address, target.family);
    };
    const request = httpsRequest({
      protocol: "https:",
      hostname: target.hostname,
      port: target.url.port || 443,
      path: `${target.url.pathname}${target.url.search}`,
      method: "GET",
      servername: target.hostname,
      headers: {
        accept: limits.allowedContentTypes.join(", "),
        "user-agent": "social-media-mcp/1.0",
      },
      lookup: pinnedLookup,
      timeout: limits.timeoutMs,
    }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        const location = response.headers.location;
        resolve({
          status,
          ...(typeof location === "string" ? { location } : {}),
          bytes: Buffer.alloc(0),
        });
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        resolve({ status, bytes: Buffer.alloc(0) });
        return;
      }
      const contentLength = Number(response.headers["content-length"] ?? "0");
      if (Number.isFinite(contentLength) && contentLength > limits.maxBytes) {
        response.destroy();
        reject(new Error("Remote media exceeds the configured maximum size."));
        return;
      }
      const contentTypeHeader = response.headers["content-type"];
      const contentType = typeof contentTypeHeader === "string"
        ? contentTypeHeader.split(";")[0]!.trim().toLowerCase()
        : "";
      const chunks: Buffer[] = [];
      let total = 0;
      response.on("data", (chunk: Buffer) => {
        total += chunk.byteLength;
        if (total > limits.maxBytes) {
          response.destroy(new Error("Remote media exceeds the configured maximum size."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        resolve({
          status,
          ...(contentType ? { contentType } : {}),
          bytes: Buffer.concat(chunks, total),
        });
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Remote media request timed out.")));
    request.on("error", reject);
    request.end();
  });
}

export async function fetchRemoteMedia(rawUrl: string, limits: RemoteMediaLimits): Promise<RemoteMedia> {
  let current = rawUrl;
  const maxRedirects = limits.maxRedirects ?? 5;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const target = await resolvePublicHttpsUrl(current);
    const response = await requestOnce(target, limits);
    if (response.status >= 300 && response.status < 400) {
      if (!response.location) throw new Error("Remote media redirect did not include a Location header.");
      current = new URL(response.location, target.url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Remote media URL returned HTTP ${response.status}.`);
    }
    const contentType = response.contentType ?? "";
    if (!limits.allowedContentTypes.includes(contentType)) {
      throw new Error(`Remote media URL returned unsupported content type: ${contentType || "missing"}.`);
    }
    const extension = extensionByContentType[contentType];
    if (!extension) {
      throw new Error(`Remote media URL returned unsupported content type: ${contentType}.`);
    }
    if (!response.bytes.byteLength) throw new Error("Remote media URL returned empty data.");
    if (!matchesMediaSignature(response.bytes, contentType)) {
      throw new Error(`Remote media URL did not contain valid ${contentType} data.`);
    }
    return {
      bytes: response.bytes,
      contentType,
      extension,
      finalUrl: target.url.toString(),
    };
  }
  throw new Error("Remote media URL redirected too many times.");
}
