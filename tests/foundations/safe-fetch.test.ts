import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { isBlockedAddress, safeFetch, SafeFetchError } from "@/lib/safe-fetch";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe", // NAT64 of 169.254.169.254
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"])("allows public %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("safeFetch URL validation", () => {
  const expectCode = async (p: Promise<unknown>, code: SafeFetchError["code"]) => {
    await expect(p).rejects.toMatchObject({ name: "SafeFetchError", code });
  };

  it("rejects non-http(s) protocols", async () => {
    await expectCode(safeFetch("file:///etc/passwd"), "BLOCKED_PROTOCOL");
    await expectCode(safeFetch("gopher://example.com"), "BLOCKED_PROTOCOL");
  });

  it("rejects plain http unless allowed", async () => {
    await expectCode(safeFetch("http://example.com"), "BLOCKED_PROTOCOL");
  });

  it("rejects literal private and metadata IPs", async () => {
    await expectCode(safeFetch("https://169.254.169.254/latest/meta-data/"), "BLOCKED_ADDRESS");
    await expectCode(safeFetch("http://127.0.0.1:6379", { allowHttp: true }), "BLOCKED_ADDRESS");
    await expectCode(safeFetch("https://[::1]/"), "BLOCKED_ADDRESS");
    await expectCode(safeFetch("http://[::ffff:7f00:1]/", { allowHttp: true }), "BLOCKED_ADDRESS");
  });

  it("rejects localhost-style hostnames and URL credentials", async () => {
    await expectCode(safeFetch("https://localhost/"), "BLOCKED_ADDRESS");
    await expectCode(safeFetch("https://metadata.google.internal/"), "BLOCKED_ADDRESS");
    await expectCode(safeFetch("https://user:pass@example.com/"), "INVALID_URL");
  });
});

describe("safeFetch against a local server", () => {
  let server: http.Server;
  let origin: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello");
      } else if (req.url === "/redirect-to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
      } else if (req.url === "/redirect-loop") {
        res.writeHead(302, { location: "/redirect-loop" });
        res.end();
      } else if (req.url === "/big") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(2048));
      } else if (req.url === "/slow") {
        setTimeout(() => res.end("late"), 2_000);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("is blocked by default (loopback)", async () => {
    await expect(safeFetch(`${origin}/ok`, { allowHttp: true })).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
  });

  it("fetches an explicitly exempted test origin", async () => {
    const res = await safeFetch(`${origin}/ok`, { allowHttp: true, unsafeTestAllowOrigins: [origin] });
    expect(res.status).toBe(200);
    expect(res.text()).toBe("hello");
  });

  it("re-validates redirect targets (redirect to metadata is blocked)", async () => {
    await expect(
      safeFetch(`${origin}/redirect-to-metadata`, { allowHttp: true, unsafeTestAllowOrigins: [origin] })
    ).rejects.toMatchObject({ code: "BLOCKED_ADDRESS" });
  });

  it("caps redirects", async () => {
    await expect(
      safeFetch(`${origin}/redirect-loop`, { allowHttp: true, unsafeTestAllowOrigins: [origin], maxRedirects: 3 })
    ).rejects.toMatchObject({ code: "TOO_MANY_REDIRECTS" });
  });

  it("caps response size", async () => {
    await expect(
      safeFetch(`${origin}/big`, { allowHttp: true, unsafeTestAllowOrigins: [origin], maxBytes: 1024 })
    ).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("times out", async () => {
    await expect(
      safeFetch(`${origin}/slow`, { allowHttp: true, unsafeTestAllowOrigins: [origin], timeoutMs: 200 })
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});
