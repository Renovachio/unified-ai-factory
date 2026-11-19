import type { Sql } from "@factory/db";
import { evaluatePolicy, type PolicyConfig, type RiskLevel, type UncertaintySignal } from "@factory/domain";
import type { PolicyPort, ReviewPort } from "@factory/orchestrator";

interface Store { get(digest: string): Buffer }

export interface PolicyPortDeps {
  sql: Sql;
  store: Store;
  policy: PolicyConfig;
  policyDigest: string;
  review: Pick<ReviewPort, "requiredRoles">;
  calibrated?: boolean;
}

/** Orchestrator PolicyPort: derives every input from DURABLE evidence (candidates, gates, reviews), never from agent claims. */
export function createPolicyPort(d: PolicyPortDeps): PolicyPort {
  return {
    async evaluate(job, headSha) {
      const arts = await d.sql<{ kind: string; digest: string }[]>`SELECT kind, digest FROM artifacts WHERE job_id = ${job.id} AND (kind ~ '^(build|test-plan)\\.r[0-9]+\\.json$' OR kind LIKE 'patch.%' OR kind = 'traceability.json')`;
      const files = new Set<string>();
      const signals = new Set<UncertaintySignal>();
      let have = false;
      for (const a of arts.filter((x) => /^(build|test-plan)\./.test(x.kind))) {
        try {
          const desc = JSON.parse(d.store.get(a.digest).toString("utf8")) as { noop?: boolean; files?: Array<{ path: string; mode?: string; status?: string }> };
          if (desc.noop) continue;
          have = true;
          for (const f of desc.files ?? []) {
            files.add(f.path);
            if (f.mode === "120000") signals.add("symlink");
            if (f.mode === "160000") signals.add("submodule");
            if (f.status === "R") signals.add("rename-across-boundary");
          }
        } catch { signals.add("diff-unavailable"); }
      }
      for (const p of arts.filter((x) => x.kind.startsWith("patch."))) {
        try { const t = d.store.get(p.digest).toString("utf8"); if (/^GIT binary patch$|^Binary files /m.test(t)) signals.add("binary-change"); if (/^(old|new) mode /m.test(t)) signals.add("mode-change"); } catch { signals.add("diff-unavailable"); }
      }
      let specFloor: RiskLevel | undefined;
      const tr = arts.find((x) => x.kind === "traceability.json");
      if (tr) { try { specFloor = (JSON.parse(d.store.get(tr.digest).toString("utf8")) as { riskFloor?: RiskLevel }).riskFloor; } catch { signals.add("diff-unavailable"); } }
      const [intake] = await d.sql<{ floor: string | null }[]>`SELECT payload_redacted->>'deterministic_floor' AS floor FROM events WHERE job_id = ${job.id} AND type = 'intake.decision' ORDER BY sequence DESC LIMIT 1`;
      if (!intake) signals.add("intake-unclassified");
      const [jr] = await d.sql<{ risk: RiskLevel; risk_classified: boolean }[]>`SELECT risk, risk_classified FROM jobs WHERE id = ${job.id}`;
      const [gate] = await d.sql<{ verdict: string }[]>`SELECT verdict FROM gate_results WHERE job_id = ${job.id} AND head_sha = ${headSha} AND verdict = 'pass' LIMIT 1`;
      const roles = await d.review.requiredRoles(job);
      const passed = await d.sql<{ reviewer_role: string }[]>`SELECT DISTINCT reviewer_role FROM review_results WHERE job_id = ${job.id} AND head_sha = ${headSha} AND verdict = 'pass'`;
      const decision = evaluatePolicy({
        policy: d.policy, policyDigest: d.policyDigest, changedFiles: have ? [...files] : null,
        ...(intake?.floor ? { textFloor: intake.floor as RiskLevel } : {}), ...(specFloor ? { specFloor } : {}),
        ...(jr?.risk_classified ? { currentRisk: jr.risk } : {}), uncertainty: [...signals],
        gate: { passed: !!gate, boundToHead: !!gate }, reviews: { allRequiredPassed: roles.every((r) => passed.some((p) => p.reviewer_role === r)) },
        ...(d.calibrated ? { calibrated: true } : {}),
      });
      return { risk: decision.risk, eligible: decision.autoMergeEligible, reasons: [...decision.reasons, ...decision.blockers.map((b) => `blocker: ${b}`)], policyDigest: decision.policyDigest };
    },
  };
}
