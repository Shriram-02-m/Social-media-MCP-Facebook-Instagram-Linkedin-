import assert from "node:assert/strict";
import test from "node:test";
import { isPrivateIpAddress, resolvePublicHttpsUrl } from "../src/utils/remote-media.js";

test("rejects private, loopback, link-local, and reserved IP addresses", () => {
  for (const address of [
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.5.4",
    "192.0.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:10.0.0.1",
    "not-an-ip",
  ]) {
    assert.equal(isPrivateIpAddress(address), true, `${address} should be rejected`);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateIpAddress(address), false, `${address} should be allowed`);
  }
});

test("resolves only public HTTPS media URLs", async () => {
  await assert.rejects(() => resolvePublicHttpsUrl("http://example.com/a.jpg"), /HTTPS/);
  await assert.rejects(() => resolvePublicHttpsUrl("https://user:pass@example.com/a.jpg"), /credentials/);
  await assert.rejects(() => resolvePublicHttpsUrl("https://localhost/a.jpg"), /publicly reachable/);
  await assert.rejects(() => resolvePublicHttpsUrl("https://127.0.0.1/a.jpg"), /private|reserved|loopback/);
  await assert.rejects(() => resolvePublicHttpsUrl("not-a-url"), /absolute URL/);

  const target = await resolvePublicHttpsUrl("https://8.8.8.8/media/a.jpg");
  assert.equal(target.address, "8.8.8.8");
  assert.equal(target.hostname, "8.8.8.8");
  assert.equal(target.url.toString(), "https://8.8.8.8/media/a.jpg");
});

test("rejects SSRF targets before any outbound request", async () => {
  for (const url of [
    "https://10.0.0.1/media/a.jpg",
    "https://172.16.0.1/media/a.jpg",
    "https://192.168.0.5/media/a.jpg",
    "https://169.254.169.254/latest/meta-data/",
    "https://127.0.0.1/media/a.jpg",
    "https://[::1]/media/a.jpg",
    "https://[fe80::1]/media/a.jpg",
    "https://localhost/media/a.jpg",
    "http://example.com/media/a.jpg",
    "https://user:pass@example.com/media/a.jpg",
  ]) {
    await assert.rejects(() => resolvePublicHttpsUrl(url), /HTTPS|credentials|publicly reachable|private|reserved|loopback/);
  }
});

test("accepts a public HTTPS image URL", async () => {
  const target = await resolvePublicHttpsUrl("https://8.8.8.8/media/image.png");
  assert.equal(target.url.protocol, "https:");
  assert.equal(target.address, "8.8.8.8");
});
