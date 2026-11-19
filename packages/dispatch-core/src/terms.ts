import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type TermsCheck = { approved: true; reviewedOn: string; scope: string } | { approved: false; reason: string };
/**
 * Has the OPERATOR recorded a provider-terms approval for this adapter in `config/provider-terms.json`? Dispatch never writes that file and never
 * decides what a provider's terms allow. Missing/invalid/expired entries mean "not approved" (fail closed).
 */
export function termsApproval(configDir: string | undefined, adapterId: string, now: Date = new Date()): TermsCheck {
  if (!configDir) return { approved: false, reason: "no config folder found" };
  const file = join(configDir, "provider-terms.json");
  if (!existsSync(file)) return { approved: false, reason: `${file} does not exist` };
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { approvals?: Array<{ adapterId?: unknown; termsReviewedOn?: unknown; scope?: unknown; expiresOn?: unknown; approvedBy?: unknown; termsUrl?: unknown }> };
    const a = (j.approvals ?? []).find((x) => x.adapterId === adapterId && typeof x.approvedBy === "string" && x.approvedBy !== "" && typeof x.termsUrl === "string" && typeof x.termsReviewedOn === "string" && typeof x.scope === "string");
    if (!a) return { approved: false, reason: `no approval is recorded for "${adapterId}" in ${file}` };
    if (typeof a.expiresOn === "string" && !(Date.parse(a.expiresOn) > now.getTime())) return { approved: false, reason: `the recorded approval for "${adapterId}" has expired (${a.expiresOn})` };
    return { approved: true, reviewedOn: String(a.termsReviewedOn), scope: String(a.scope) };
  } catch { return { approved: false, reason: `${file} could not be read as JSON` }; }
}
