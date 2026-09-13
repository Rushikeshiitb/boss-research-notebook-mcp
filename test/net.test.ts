import { describe, it, expect } from "vitest";
import {
  assertUrlAllowed,
  createSafeFetch,
  FetchLimitError,
  isFetchableUrl,
  isPrivateAddress,
  readCappedText,
  UnsafeUrlError,
  type RawFetchFn,
  type RawResponse,
  type ResolveHostFn,
} from "../src/net.js";

// --- Helpers ---------------------------------------------------------------

async function* bytes(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield new TextEncoder().encode(p);
}

function response(
  status: number,
  opts: { body?: string; location?: string; contentLength?: number } = {},
): RawResponse {
  const headers = new Map<string, string>();
  if (opts.location) headers.set("location", opts.location);
  if (opts.contentLength !== undefined) headers.set("content-length", String(opts.contentLength));
  return {
    status,
    headers: { get: (n) => headers.get(n.toLowerCase()) ?? null },
    body: opts.body === undefined ? null : bytes(opts.body),
  };
}

// A resolver that answers with whatever it is told, keyed by hostname.
function resolverFor(map: Record<string, string[]>): ResolveHostFn {
  return async (hostname) => map[hostname] ?? ["93.184.216.34"]; // default: a public IP
}

describe("isPrivateAddress", () => {
  it("classifies IPv6 loopback, link-local, ULA and mapped IPv4", () => {
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fc00::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false); // public (1.1.1.1 v6)
  });

  it("classifies IPv4 private, CGNAT and reserved ranges", () => {
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true); // CGNAT
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });
});

describe("isFetchableUrl", () => {
  it("accepts public http/https including public IP literals", () => {
    expect(isFetchableUrl("https://arxiv.org/abs/1706.03762")).toBe(true);
    expect(isFetchableUrl("http://example.com/a?b=1")).toBe(true);
    expect(isFetchableUrl("https://8.8.8.8/")).toBe(true);
    expect(isFetchableUrl("https://[2606:4700:4700::1111]/")).toBe(true);
  });

  it("rejects non-http(s), localhost and private IPv4 literals", () => {
    expect(isFetchableUrl("file:///etc/passwd")).toBe(false);
    expect(isFetchableUrl("ftp://example.com/x")).toBe(false);
    expect(isFetchableUrl("not a url")).toBe(false);
    expect(isFetchableUrl("http://localhost/")).toBe(false);
    expect(isFetchableUrl("http://app.localhost/")).toBe(false);
    expect(isFetchableUrl("http://127.0.0.1/")).toBe(false);
    expect(isFetchableUrl("http://169.254.169.254/")).toBe(false);
    expect(isFetchableUrl("http://192.168.0.1/")).toBe(false);
  });

  it("rejects IPv6 loopback, link-local, ULA and mapped-IPv4 literals", () => {
    expect(isFetchableUrl("http://[::1]/")).toBe(false);
    expect(isFetchableUrl("http://[fe80::1]/")).toBe(false);
    expect(isFetchableUrl("http://[fd00::1]/")).toBe(false);
    expect(isFetchableUrl("http://[::ffff:127.0.0.1]/")).toBe(false);
  });
});

describe("assertUrlAllowed", () => {
  it("refuses a hostname whose DNS answer is private (rebinding)", async () => {
    const resolve = resolverFor({ "evil.example": ["127.0.0.1"] });
    await expect(assertUrlAllowed("http://evil.example/", resolve)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it("refuses when ANY of several answers is private", async () => {
    const resolve = resolverFor({ "mixed.example": ["8.8.8.8", "10.0.0.5"] });
    await expect(assertUrlAllowed("http://mixed.example/", resolve)).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it("returns the validated addresses for a public name", async () => {
    const resolve = resolverFor({ "good.example": ["93.184.216.34"] });
    await expect(assertUrlAllowed("https://good.example/", resolve)).resolves.toEqual([
      "93.184.216.34",
    ]);
  });

  it("does not resolve a public IP literal", async () => {
    let called = false;
    const resolve: ResolveHostFn = async () => {
      called = true;
      return [];
    };
    await expect(assertUrlAllowed("https://8.8.8.8/", resolve)).resolves.toEqual(["8.8.8.8"]);
    expect(called).toBe(false);
  });
});

describe("readCappedText", () => {
  it("reads a body under the cap", async () => {
    expect(await readCappedText(bytes("hello ", "world"), 100)).toBe("hello world");
    expect(await readCappedText(null, 100)).toBe("");
  });

  it("throws once the streamed body exceeds the cap", async () => {
    await expect(readCappedText(bytes("a".repeat(40), "b".repeat(40)), 50)).rejects.toBeInstanceOf(
      FetchLimitError,
    );
  });
});

describe("createSafeFetch", () => {
  it("fetches an allowed public page", async () => {
    const rawFetch: RawFetchFn = async (url, init) => {
      expect(init.pinnedAddresses).toEqual(["93.184.216.34"]);
      expect(url).toBe("https://good.example/");
      return response(200, { body: "<title>ok</title>" });
    };
    const fetchFn = createSafeFetch({
      rawFetch,
      resolveHost: resolverFor({ "good.example": ["93.184.216.34"] }),
    });
    const res = await fetchFn("https://good.example/");
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("<title>ok</title>");
  });

  it("refuses a redirect from a public page to a private address", async () => {
    const rawFetch: RawFetchFn = async (url) => {
      if (url === "https://public.example/")
        return response(302, { location: "http://169.254.169.254/latest/meta-data/" });
      throw new Error(`unexpected second hop to ${url}`);
    };
    const fetchFn = createSafeFetch({
      rawFetch,
      resolveHost: resolverFor({ "public.example": ["93.184.216.34"] }),
    });
    await expect(fetchFn("https://public.example/")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("follows a safe redirect to another public page", async () => {
    const rawFetch: RawFetchFn = async (url) => {
      if (url === "https://a.example/") return response(301, { location: "https://b.example/" });
      if (url === "https://b.example/") return response(200, { body: "final" });
      throw new Error(`unexpected ${url}`);
    };
    const fetchFn = createSafeFetch({
      rawFetch,
      resolveHost: resolverFor({ "a.example": ["93.184.216.34"], "b.example": ["93.184.216.35"] }),
    });
    const res = await fetchFn("https://a.example/");
    expect(await res.text()).toBe("final");
  });

  it("stops after too many redirects", async () => {
    const rawFetch: RawFetchFn = async () =>
      response(302, { location: "https://loop.example/next" });
    const fetchFn = createSafeFetch({
      rawFetch,
      resolveHost: resolverFor({ "loop.example": ["93.184.216.34"] }),
      maxRedirects: 3,
    });
    await expect(fetchFn("https://loop.example/")).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("rejects an over-cap body up front via content-length", async () => {
    const rawFetch: RawFetchFn = async () =>
      response(200, { body: "x".repeat(10), contentLength: 10_000 });
    const fetchFn = createSafeFetch({
      rawFetch,
      resolveHost: resolverFor({ "big.example": ["93.184.216.34"] }),
      maxBytes: 100,
    });
    const res = await fetchFn("https://big.example/");
    await expect(res.text()).rejects.toBeInstanceOf(FetchLimitError);
  });

  it("rejects an over-cap body that lies about content-length", async () => {
    const rawFetch: RawFetchFn = async () => ({
      status: 200,
      headers: { get: (n) => (n.toLowerCase() === "content-length" ? "5" : null) },
      body: bytes("x".repeat(500)),
    });
    const fetchFn = createSafeFetch({
      rawFetch,
      resolveHost: resolverFor({ "liar.example": ["93.184.216.34"] }),
      maxBytes: 100,
    });
    const res = await fetchFn("https://liar.example/");
    await expect(res.text()).rejects.toBeInstanceOf(FetchLimitError);
  });
});
