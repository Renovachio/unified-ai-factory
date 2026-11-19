import { wilsonLower } from "@factory/runtimes";
import type { BenchmarkResult } from "./score";

export interface RoleProposal {
  role: "builder" | "review_code" | "review_security";
  samples: number;
  passes: number;
  rate: number;
  wilsonLower95: number;
  criticalMisses: number;
  falsePositives: number;
  cleanSamples: number;
}
/**
 * Turns a benchmark run into numbers a human can approve or reject. This NEVER produces an approval: registry records need approvedBy/approvedOn/expiresOn
 * from an operator, and `checkQualification` still rejects anything below target or below the minimum sample size.
 */
export function proposeQualification(r: BenchmarkResult): RoleProposal[] {
  const defects = r.results.filter((x) => x.kind === "review_defect");
  const sec = defects.filter((x) => x.securityRelevant);
  const clean = r.results.filter((x) => x.kind === "review_clean");
  const builders = r.results.filter((x) => x.kind === "builder");
  const fp = clean.filter((x) => x.falsePositive).length;
  const mk = (role: RoleProposal["role"], xs: typeof defects, pass: (x: (typeof defects)[number]) => boolean, misses: number): RoleProposal => {
    const passes = xs.filter(pass).length;
    return { role, samples: xs.length, passes, rate: xs.length ? passes / xs.length : 0, wilsonLower95: wilsonLower(passes, xs.length), criticalMisses: misses, falsePositives: fp, cleanSamples: clean.length };
  };
  return [
    mk("builder", builders, (x) => x.acceptancePass === true, 0),
    mk("review_code", defects, (x) => x.detected === true, defects.filter((x) => x.detected !== true && x.securityRelevant).length),
    mk("review_security", sec, (x) => x.detected === true, sec.filter((x) => x.detected !== true).length),
  ];
}
