// Address classification for sandbox egress (used by isForbiddenTarget).
//
// Input is a WHATWG URL hostname, which is already canonical for IP literals:
// "127.1", "2130706433" and "0x7f000001" become "127.0.0.1", and IPv6 is
// lower-case, bracketed and compressed ("[::ffff:7f00:1]"). Names get a light
// canonicalisation here (lower-case, trailing dots removed).
//
// What this does NOT do: resolve DNS. A name such as "evil.example" that resolves
// to 127.0.0.1, or re-resolves between check and connect (DNS rebinding), is not
// caught here. MockSandbox never resolves names and only serves allowlisted
// fixtures, so the gap cannot be exercised in mock mode; a real egress proxy must
// resolve once, check the resolved address with this function, and connect to
// that exact address.

export type AddressClass = "metadata" | "loopback" | "link-local" | "private" | "reserved" | "multicast" | null;

/** Lower-case and strip trailing dots ("LOCALHOST." → "localhost"). */
export function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

function parseIPv4(h: string): number[] | null {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** IPv6 literal (without brackets) → 8 hextets, or null. Accepts an embedded dotted IPv4 tail. */
export function parseIPv6(s: string): number[] | null {
  let str = s.toLowerCase();
  if (str.includes("%")) return null; // zone ids never reach here from WHATWG URL
  const tail = str.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (tail) {
    const v4 = parseIPv4(tail[1]);
    if (!v4) return null;
    str = `${str.slice(0, -tail[1].length)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x ? x.split(":") : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if ((halves.length === 2 && fill < 1) || (halves.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...rest];
  if (all.length !== 8 || !all.every((x) => /^[0-9a-f]{1,4}$/.test(x))) return null;
  return all.map((x) => Number.parseInt(x, 16));
}

function classifyIPv4(o: number[]): AddressClass {
  const [a, b, c] = o;
  if (a === 169 && b === 254) return o[2] === 169 && o[3] === 254 ? "metadata" : "link-local";
  if (a === 127 || a === 0) return "loopback"; // 0.0.0.0/8 reaches the host on most stacks
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return "private";
  if (a >= 224 && a <= 239) return "multicast";
  if (a >= 240) return "reserved"; // 240/4 and 255.255.255.255
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking 198.18/15
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return "reserved"; // 192.0.0/24 IETF, 192.0.2/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return "reserved"; // 6to4 relay anycast
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return "reserved"; // TEST-NET-2/3
  return null;
}

const v4From = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

function classifyIPv6(w: number[]): AddressClass {
  const zeroUpTo = (n: number) => w.slice(0, n).every((x) => x === 0);
  if (zeroUpTo(8)) return "loopback"; // :: unspecified
  if (zeroUpTo(7) && w[7] === 1) return "loopback"; // ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d (deprecated): name the IPv4 class
  // when it has one; either way the sandbox has no reason to use these forms, so they are refused.
  if ((zeroUpTo(5) && w[5] === 0xffff) || zeroUpTo(6)) return classifyIPv4(v4From(w[6], w[7])) ?? "reserved";
  // NAT64 64:ff9b::/96 (and local-use 64:ff9b:1::/48): judge the embedded IPv4.
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return classifyIPv4(v4From(w[6], w[7]));
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return "reserved";
  if (w[0] === 0x2002) return classifyIPv4(v4From(w[1], w[2])); // 6to4 embeds an IPv4
  if (w[0] === 0x2001 && w[1] === 0) return "reserved"; // Teredo (obfuscated IPv4)
  if (w[0] === 0x2001 && w[1] === 0xdb8) return "reserved"; // documentation
  if (w[0] === 0x100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return "reserved"; // discard 100::/64
  if (w[0] === 0xfd00 && w[1] === 0xec2 && w.slice(2, 7).every((x) => x === 0) && w[7] === 0x254) return "metadata"; // AWS IPv6 IMDS
  if ((w[0] & 0xfe00) === 0xfc00) return "private"; // fc00::/7 ULA
  if ((w[0] & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((w[0] & 0xffc0) === 0xfec0) return "private"; // fec0::/10 site-local (deprecated)
  if ((w[0] & 0xff00) === 0xff00) return "multicast";
  return null;
}

const LOOPBACK_NAMES = /^(localhost|localhost\.localdomain|ip6-localhost|ip6-loopback)$|\.localhost$/;
const METADATA_NAMES = /^(metadata|metadata\.google\.internal|instance-data|instance-data\.ec2\.internal)$/;
const PRIVATE_NAMES = /\.(internal|local|lan|home\.arpa|localdomain)$/;

/** Classify a URL hostname. null = not a known-dangerous literal or name (DNS is not resolved). */
export function classifyHost(hostname: string): AddressClass {
  const h = canonicalHost(hostname);
  if (h.startsWith("[") && h.endsWith("]")) {
    const w = parseIPv6(h.slice(1, -1));
    return w ? classifyIPv6(w) : "reserved"; // unparseable literal: refuse
  }
  const v4 = parseIPv4(h);
  if (v4) return classifyIPv4(v4);
  if (LOOPBACK_NAMES.test(h)) return "loopback";
  if (METADATA_NAMES.test(h)) return "metadata";
  if (PRIVATE_NAMES.test(h)) return "private";
  return null;
}
