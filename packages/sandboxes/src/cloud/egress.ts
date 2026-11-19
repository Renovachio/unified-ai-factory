import { isIP } from "node:net";
import type { CloudConfig } from "./config";

export interface EgressDecision { allowed: boolean; reason: string }

function ipv4ToInt(ip: string): number { return ip.split(".").reduce((a, b) => (a << 8) + Number(b), 0) >>> 0; }
function inCidr4(ip: string, cidr: string): boolean {
  const [base, bitsS] = cidr.split("/");
  const bits = Number(bitsS);
  if (!base || isIP(base) !== 4 || Number.isNaN(bits)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}
function expandV6(ip: string): bigint | null {
  if (isIP(ip) !== 6) return null;
  const m4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  let s = ip;
  if (m4) { const n = ipv4ToInt(m4[2] as string); s = `${m4[1]}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`; }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = s.includes("::") ? Array(8 - h.length - t.length).fill("0") : [];
  const parts = [...h, ...fill, ...t];
  if (parts.length !== 8) return null;
  return parts.reduce((a, p) => (a << 16n) + BigInt(parseInt(p || "0", 16)), 0n);
}
function inCidr6(ip: string, cidr: string): boolean {
  const [base, bitsS] = cidr.split("/");
  const a = expandV6(ip); const b = base ? expandV6(base) : null; const bits = BigInt(bitsS ?? "128");
  if (a === null || b === null) return false;
  const shift = 128n - bits;
  return (a >> shift) === (b >> shift);
}
/** IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by its IPv4 part so it cannot be used to dodge the v4 deny list. */
function mappedV4(ip: string): string | null {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1] as string;
  const v = expandV6(ip);
  if (v !== null && (v >> 32n) === 0xffffn) { const n = Number(v & 0xffffffffn); return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."); }
  return null;
}

/**
 * Deny-by-default egress policy for cloud sandboxes (also the SSRF guard). A destination must be an allowlisted HOST over https, and every
 * address it resolves to must be public: metadata endpoints, loopback, RFC1918/CGNAT/link-local and IPv4-mapped tricks are always refused.
 */
export class EgressPolicy {
  constructor(private readonly cfg: CloudConfig["egress"], private readonly resolve: (host: string) => Promise<string[]> = async () => []) {}

  checkIp(ip: string): EgressDecision {
    const v4 = isIP(ip) === 4 ? ip : mappedV4(ip);
    if (v4) { for (const c of this.cfg.deniedCidrs) if (c.includes(".") && inCidr4(v4, c)) return { allowed: false, reason: `address ${ip} is in denied range ${c}` }; return { allowed: true, reason: "public address" }; }
    if (isIP(ip) === 6) { for (const c of this.cfg.deniedCidrs) if (c.includes(":") && inCidr6(ip, c)) return { allowed: false, reason: `address ${ip} is in denied range ${c}` }; return { allowed: true, reason: "public address" }; }
    return { allowed: false, reason: `not an IP address: ${ip}` };
  }

  async check(rawUrl: string): Promise<EgressDecision> {
    let u: URL;
    try { u = new URL(rawUrl); } catch { return { allowed: false, reason: "unparseable URL" }; }
    if (u.protocol !== "https:") return { allowed: false, reason: `scheme ${u.protocol} is not allowed (https only)` };
    if (u.username || u.password) return { allowed: false, reason: "credentials in URL are not allowed" };
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (this.cfg.deniedHostnames.some((d) => host === d || host.endsWith("." + d))) return { allowed: false, reason: `hostname ${host} is denied` };
    if (isIP(host) !== 0) { const d = this.checkIp(host); if (!d.allowed) return d; return this.cfg.allowedHosts.includes(host) ? d : { allowed: false, reason: `${host} is not allowlisted` }; }
    if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return { allowed: false, reason: "numeric host encodings are not allowed" };
    if (!this.cfg.allowedHosts.includes(host)) return { allowed: false, reason: `${host} is not allowlisted` };
    // DNS-rebinding / split-horizon defence: every resolved address must be public.
    for (const ip of await this.resolve(host)) { const d = this.checkIp(ip); if (!d.allowed) return { allowed: false, reason: `${host} resolves to a forbidden address: ${d.reason}` }; }
    return { allowed: true, reason: "allowlisted host with public addresses" };
  }
}
