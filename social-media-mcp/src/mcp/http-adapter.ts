import type { IncomingMessage, ServerResponse } from "node:http";

// Small Node <-> Web adapter for the MCP Streamable HTTP handler. The SDK's
// `createMcpHandler` is fetch-shaped; `@modelcontextprotocol/node` is not
// installed, so this module converts one node:http request/response pair at a
// time. Bodies are bounded before parsing, and SSE responses are streamed.

export const DEFAULT_MCP_BODY_LIMIT = 4 * 1024 * 1024;

export class HttpBodyTooLargeError extends Error {
  constructor() {
    super("Request body is too large.");
    this.name = "HttpBodyTooLargeError";
  }
}

function requestUrl(request: IncomingMessage, publicUrl: string): URL {
  return new URL(request.url ?? "/", publicUrl);
}

function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (name === "connection" || name === "transfer-encoding" || name === "keep-alive") continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Uint8Array | undefined> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume();
    throw new HttpBodyTooLargeError();
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      request.resume();
      throw new HttpBodyTooLargeError();
    }
    chunks.push(buffer);
  }
  if (!total) return undefined;
  return Buffer.concat(chunks, total);
}

export async function toWebRequest(
  request: IncomingMessage,
  publicUrl: string,
  maxBytes = DEFAULT_MCP_BODY_LIMIT,
): Promise<Request> {
  const method = (request.method ?? "GET").toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request, maxBytes);
  return new Request(requestUrl(request, publicUrl), {
    method,
    headers: requestHeaders(request),
    ...(body ? { body: Uint8Array.from(body).buffer } : {}),
  });
}

function responseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name === "connection" || name === "keep-alive" || name === "transfer-encoding" || name === "upgrade") return;
    headers[name] = value;
  });
  return headers;
}

export async function sendWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  const headers = responseHeaders(webResponse);
  const contentType = webResponse.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && webResponse.body) {
    response.writeHead(webResponse.status, headers);
    const reader = webResponse.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!response.write(Buffer.from(value))) {
          await new Promise<void>((resolve) => response.once("drain", resolve));
        }
      }
    } finally {
      reader.releaseLock();
    }
    response.end();
    return;
  }
  const body = Buffer.from(await webResponse.arrayBuffer());
  if (webResponse.status !== 204 && webResponse.status !== 304) {
    headers["content-length"] = String(body.byteLength);
  }
  response.writeHead(webResponse.status, headers);
  response.end(body);
}
