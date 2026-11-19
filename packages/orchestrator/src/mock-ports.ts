import { createHash } from "node:crypto";
import type { RiskLevel } from "@factory/domain";
import type { JobCtx, Ports } from "./ports";

const fakeSha = (...parts: Array<string | number>) => createHash("sha1").update(parts.join("|")).digest("hex");

export interface MockPortOptions {
  /** Rounds (0-based) in which the deterministic gate fails. */
  gateFailRounds?: number[];
  /** Rounds in which the code reviewer requests changes. */
  reviewChangesRounds?: number[];
  roles?: string[];
  risk?: RiskLevel;
  calls?: string[];
}

/** In-memory ports: deterministic and idempotent, used for the mock end-to-end pipeline and fault-injection tests. */
export function mockPorts(o: MockPortOptions = {}): Ports {
  const calls = o.calls ?? [];
  const prs = new Map<string, { prNumber: number; url: string }>();
  return {
    scm: {
      async prepare(job) { calls.push("scm.prepare"); return { baseSha: fakeSha("base", job.repositoryId) }; },
      async commitCandidate(job, round) { calls.push("scm.commit"); return { headSha: fakeSha("head", job.id, round) }; },
      async ensureDraftPr(job, headSha) {
        calls.push("scm.pr");
        const key = job.id;
        if (!prs.has(key)) prs.set(key, { prNumber: prs.size + 1, url: `https://example.invalid/pr/${prs.size + 1}` });
        void headSha;
        return prs.get(key) as { prNumber: number; url: string };
      },
    },
    gate: {
      async run(job, headSha, baseSha) {
        calls.push("gate.run");
        const failed = (o.gateFailRounds ?? []).includes(job.round);
        return { verdict: failed ? "fail" : "pass", configDigest: "sha256:" + fakeSha("gatecfg"), resultsDigest: "sha256:" + fakeSha("gate", headSha, baseSha, failed ? "f" : "p") };
      },
    },
    review: {
      requiredRoles: () => o.roles ?? ["code"],
      async run(job, role, headSha) {
        calls.push(`review.${role}`);
        const changes = role === "code" && (o.reviewChangesRounds ?? []).includes(job.round);
        return { verdict: changes ? "changes_requested" : "pass", findingsDigest: "sha256:" + fakeSha("review", role, headSha, changes ? "c" : "p") };
      },
    },
    policy: {
      async evaluate(_job: JobCtx, headSha) {
        calls.push("policy.evaluate");
        return { risk: o.risk ?? "MEDIUM", eligible: false, reasons: ["pilot: every merge is manual"], policyDigest: "sha256:" + fakeSha("policy", headSha) };
      },
    },
  };
}
