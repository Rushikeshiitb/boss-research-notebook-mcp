/**
 * Outbound-fetch safety for `cite_url`.
 *
 * The agent, not the user, chooses the URL `cite_url` fetches, and the agent's
 * context routinely contains page text it did not write. So the server must
 * treat that URL as hostile and refuse anything that could reach the host's own
 * network: loopback, link-local (cloud metadata at 169.254.169.254), and
 * private ranges - reached directly, through a DNS name that resolves to one of
 * them, or via a redirect from an innocuous public page.
 *
 * Everything here is pure or driven by injected seams (`rawFetch`,
 * `resolveHost`) so the whole guard is deterministically testable with no
 * network: see `test/net.test.ts`.
 */
import { lookup as dnsLookupCb } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

/** Response body grew past the byte cap. */
export class FetchLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchLimitError";
  }
}

/** The URL (or a redirect target, or a resolved address) is not allowed. */
export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** Largest response body cite_url will buffer (5 MiB). */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Largest number of redirect hops cite_url will follow. */
export const DEFAULT_MAX_REDIRECTS = 5;

// --- Address classification ------------------------------------------------

function ipv4Octets(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((n) => n > 255)) return null;
  return octets as [number, number, number, number];
}

/** Whether a dotted-quad literal is loopback, private, link-local or reserved. */
export function isPrivateIpv4(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0/24 protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved (incl. 255.255.255.255)
  return false;
}

/** Whether an IPv6 literal is loopback, unspecified, link-local, ULA, mapped-private or multicast. */
export function isPrivateIpv6(host: string): boolean {
  // Drop a zone id (fe80::1%eth0) and any surrounding brackets.
  const h = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");

  // IPv4-mapped/compatible forms carry an embedded IPv4. Browsers and Node
  // canonicalise ::ffff:127.0.0.1 to its hex form ::ffff:7f00:1, so handle both
  // the dotted tail and the two trailing hex groups.
  const dotted = h.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return isPrivateIpv4(dotted[1]);
  const hex = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    const quad = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    return isPrivateIpv4(quad);
  }

  if (h === "::1" || h === "::") return true; // loopback, unspecified
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(h)) return true; // fc00::/7 unique-local
  if (/^ff/.test(h)) return true; // ff00::/8 multicast
  return false;
}

/** A bracket-stripped host that is an IP literal (v4 or v6). */
export function isIpLiteral(host: string): boolean {
  return ipv4Octets(host) !== null || host.includes(":");
}

/** Whether an IP literal points somewhere the server must not reach. */
export function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  if (h.includes(":")) return isPrivateIpv6(h);
  return isPrivateIpv4(h);
}

function normaliseHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/**
 * A cheap, synchronous pre-check: scheme is http/https, and any literal host is
 * not private. A DNS name passes here and is resolved and re-checked at fetch
 * time (`assertUrlAllowed`), because only then do we learn its address.
 */
export function isFetchableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = normaliseHost(parsed.hostname);
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) return false;
  if (isIpLiteral(host)) return !isPrivateAddress(host);
  return true;
}

// --- Fetch seam ------------------------------------------------------------

export interface RawResponse {
  status: number;
  headers: { get(name: string): string | null };
  /** The response body as a stream of byte chunks, or null for an empty body. */
  body: AsyncIterable<Uint8Array> | null;
}

export interface RawFetchInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /**
   * Addresses the host was already resolved to and validated as public. The raw
   * fetch MUST connect to one of these rather than re-resolving, so a name that
   * passed validation cannot be rebound to a private address before the socket
   * opens.
   */
  pinnedAddresses: string[];
}

/** Performs a single request with NO redirect following. */
export type RawFetchFn = (url: string, init: RawFetchInit) => Promise<RawResponse>;

/** Resolves a hostname to its IP addresses. */
export type ResolveHostFn = (hostname: string) => Promise<string[]>;

/** A high-level fetch matching the shape cite_url consumes. */
export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface SafeFetchConfig {
  rawFetch?: RawFetchFn;
  resolveHost?: ResolveHostFn;
  maxBytes?: number;
  maxRedirects?: number;
}

/** Read an async byte stream into a string, aborting once it exceeds `maxBytes`. */
export async function readCappedText(
  body: AsyncIterable<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new FetchLimitError(`response body exceeded the ${maxBytes}-byte limit`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Resolve a URL's host and confirm it, and every address it resolves to, is
 * safe to reach. Returns the validated addresses so the caller can pin the
 * connection to them. Throws `UnsafeUrlError` otherwise.
 */
export async function assertUrlAllowed(
  url: string,
  resolveHost: ResolveHostFn,
): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError(`not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UnsafeUrlError(`only http and https are allowed, not ${parsed.protocol}`);
  }
  const host = normaliseHost(parsed.hostname);
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) {
    throw new UnsafeUrlError(`refusing to reach ${host || "(empty host)"}`);
  }
  if (isIpLiteral(host)) {
    if (isPrivateAddress(host)) {
      throw new UnsafeUrlError(`refusing to reach private address ${host}`);
    }
    return [host];
  }
  const addresses = await resolveHost(host);
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`could not resolve ${host}`);
  }
  // Fail closed: if ANY answer is private, refuse. This blocks a rebinding
  // trick that mixes one public and one private record.
  const bad = addresses.find((ip) => isPrivateAddress(ip));
  if (bad) {
    throw new UnsafeUrlError(`${host} resolves to a private address (${bad})`);
  }
  return addresses;
}

/**
 * Build a hardened fetch: every hop (the initial URL and each redirect target)
 * is scheme-checked, DNS-resolved and validated, the connection is pinned to
 * the validated address, redirects are followed manually up to `maxRedirects`,
 * and the body is capped at `maxBytes`.
 */
export function createSafeFetch(config: SafeFetchConfig = {}): FetchFn {
  const rawFetch = config.rawFetch ?? defaultRawFetch;
  const resolveHost = config.resolveHost ?? defaultResolveHost;
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  return async (startUrl, init) => {
    let url = startUrl;
    for (let hop = 0; ; hop++) {
      const addresses = await assertUrlAllowed(url, resolveHost);
      const res = await rawFetch(url, {
        headers: init?.headers,
        signal: init?.signal,
        pinnedAddresses: addresses,
      });

      const isRedirect = res.status >= 300 && res.status < 400 && res.status !== 304;
      const location = isRedirect ? res.headers.get("location") : null;
      if (isRedirect && location) {
        if (hop >= maxRedirects) {
          throw new UnsafeUrlError(`too many redirects (more than ${maxRedirects})`);
        }
        // Drain/close the redirect body so the socket is not left hanging.
        await drain(res.body);
        url = new URL(location, url).toString();
        continue;
      }

      const ok = res.status >= 200 && res.status < 300;
      const contentLength = res.headers.get("content-length");
      return {
        ok,
        status: res.status,
        text: () => {
          // Reject an honest over-cap length up front, and still stream-cap the
          // body so a missing or lying Content-Length cannot slip past.
          if (contentLength && Number(contentLength) > maxBytes) {
            return drain(res.body).then(() => {
              throw new FetchLimitError(
                `response body (${contentLength} bytes) exceeds the ${maxBytes}-byte limit`,
              );
            });
          }
          return readCappedText(res.body, maxBytes);
        },
      };
    }
  };
}

async function drain(body: AsyncIterable<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of body) {
      /* discard */
    }
  } catch {
    /* a closed/aborted body is fine to ignore here */
  }
}

// --- Production seams (not unit-tested: they touch DNS and sockets) ---------

/** Resolve every A/AAAA record for a host. */
export const defaultResolveHost: ResolveHostFn = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookupCb(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });

/**
 * A single request over node:http/https with NO automatic redirect following
 * and the socket pinned to a pre-validated address via a custom `lookup`. The
 * URL's hostname is kept for the Host header and TLS SNI; only which IP it maps
 * to is fixed.
 */
export const defaultRawFetch: RawFetchFn = (url, init) => {
  const parsed = new URL(url);
  const request = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const pinned = init.pinnedAddresses;

  const pinnedLookup = (
    _hostname: string,
    options: { all?: boolean } | ((err: Error | null, address?: string, family?: number) => void),
    callback?: (
      err: Error | null,
      address?: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ): void => {
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error | null,
      address?: string | { address: string; family: number }[],
      family?: number,
    ) => void;
    const wantsAll = typeof options === "object" && options.all === true;
    if (!pinned || pinned.length === 0) {
      cb(new UnsafeUrlError("no validated address to connect to"));
      return;
    }
    if (wantsAll) {
      cb(
        null,
        pinned.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      );
      return;
    }
    const address = pinned[0];
    cb(null, address, address.includes(":") ? 6 : 4);
  };

  return new Promise<RawResponse>((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: init.headers,
        signal: init.signal,
        lookup: pinnedLookup as never,
      },
      (res) => {
        const headers = {
          get: (name: string): string | null => {
            const value = res.headers[name.toLowerCase()];
            if (value === undefined) return null;
            return Array.isArray(value) ? value.join(", ") : value;
          },
        };
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: Readable.toWeb(res) as unknown as AsyncIterable<Uint8Array>,
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
};
