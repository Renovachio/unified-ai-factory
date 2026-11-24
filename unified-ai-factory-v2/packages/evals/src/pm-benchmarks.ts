import type { Benchmark, BenchmarkTask } from "./paired";

/**
 * STARTER v2.2 role benchmarks. Honest scope: each has only a handful of tasks, far below `minSamples`, so NO candidate can reach "passed"
 * on them; they exist to exercise the pipeline and to be grown by the dataset owner. Synthetic inputs only (no customer data).
 */
const t = (role: string, id: string, input: string, checks: BenchmarkTask["checks"], sources?: string[]): BenchmarkTask => ({ id: `${role}.${id}`, role, input, checks, ...(sources ? { sources } : {}) });

const MEET = "Meeting notes (synthetic). Attendees: Ana Silva, Bruno Costa. Ana: we ship the export feature in Q1. Bruno: I think we should maybe drop the legacy API. Nobody confirmed an owner for migration.";
const PRD = "Problem (synthetic): admins cannot bulk-invite users. Goal: reduce onboarding time. Constraint: no PII in logs.";

export const PM_BENCHMARKS: readonly Benchmark[] = [
  { name: "pm-meeting-to-backlog", version: "0.1.0", role: "pm.meeting", graderId: "grader:pm.meeting.v1", minSamples: 30, roleThreshold: 0.85,
    tasks: [t("pm.meeting", "m1", MEET, [{ type: "contains", value: "decision" }, { type: "contains", value: "proposed" }, { type: "no_invented_names", allowed: ["Ana Silva", "Bruno Costa"], critical: true }]), t("pm.meeting", "m2", MEET + " Action: Ana to draft spec.", [{ type: "contains", value: "owner" }, { type: "not_contains", value: "approved by stakeholders", critical: true }]), t("pm.meeting", "m3", MEET, [{ type: "contains", value: "uncertain" }, { type: "no_invented_names", allowed: ["Ana Silva", "Bruno Costa"], critical: true }])],
    holdout: [t("pm.meeting", "h1", "Notes (synthetic): Carla Dias proposed weekly demos. No decision recorded.", [{ type: "contains", value: "proposed" }, { type: "not_contains", value: "decided", critical: true }])] },
  { name: "pm-competitive-research", version: "0.1.0", role: "pm.research", graderId: "grader:pm.research.v1", minSamples: 30, roleThreshold: 0.85,
    tasks: [t("pm.research", "r1", "Compare tools A and B for invoicing using the provided source log.", [{ type: "cites_source", sources: ["S1", "S2"], critical: true }, { type: "contains", value: "assumption" }], ["S1", "S2"]), t("pm.research", "r2", "Which market is largest? Use only the sources.", [{ type: "cites_source", sources: ["S1"], critical: true }, { type: "contains", value: "uncertain" }], ["S1"]), t("pm.research", "r3", "Summarise competitor pricing.", [{ type: "contains", value: "source" }, { type: "not_contains", value: "industry-leading", critical: true }], ["S3"])],
    holdout: [t("pm.research", "h1", "Rank opportunities with the evidence given.", [{ type: "cites_source", sources: ["S4"], critical: true }], ["S4"])] },
  { name: "pm-prd-quality", version: "0.1.0", role: "pm.prd", graderId: "grader:pm.prd.v1", minSamples: 30, roleThreshold: 0.85,
    tasks: [t("pm.prd", "p1", PRD, [{ type: "contains", value: "non-goals" }, { type: "contains", value: "success metric" }, { type: "contains", value: "open question" }]), t("pm.prd", "p2", PRD + " Add audit logging.", [{ type: "contains", value: "risk" }, { type: "contains", value: "PII" }]), t("pm.prd", "p3", PRD, [{ type: "contains", value: "assumption" }, { type: "not_contains", value: "TBD", critical: false }])],
    holdout: [t("pm.prd", "h1", "Problem (synthetic): reports load slowly. Goal: p95 under 2s.", [{ type: "contains", value: "success metric" }, { type: "contains", value: "non-goals" }])] },
  { name: "pm-story-acceptance", version: "0.1.0", role: "pm.user_story", graderId: "grader:pm.story.v1", minSamples: 30, roleThreshold: 0.85,
    tasks: [t("pm.user_story", "s1", "Write stories for bulk invite from the PRD.", [{ type: "regex", pattern: "as an? .+ i want .+ so that" }, { type: "contains", value: "given" }, { type: "contains", value: "then" }]), t("pm.user_story", "s2", "Write stories for CSV export.", [{ type: "regex", pattern: "as an? .+ i want .+ so that" }, { type: "contains", value: "when" }]), t("pm.user_story", "s3", "Write stories for audit log.", [{ type: "contains", value: "acceptance criteria" }, { type: "contains", value: "traceab" }])],
    holdout: [t("pm.user_story", "h1", "Write stories for password reset.", [{ type: "regex", pattern: "as an? .+ i want .+ so that" }, { type: "contains", value: "given" }])] },
  { name: "pm-analytics-decision", version: "0.1.0", role: "pm.analytics", graderId: "grader:pm.analytics.v1", minSamples: 30, roleThreshold: 0.85,
    tasks: [t("pm.analytics", "a1", "Dataset (synthetic): signups 100->120, churn 5%->6%. Recommend.", [{ type: "contains", value: "limitation" }, { type: "contains", value: "confidence" }]), t("pm.analytics", "a2", "Cohort A conv 10% (n=20), B 14% (n=18). Winner?", [{ type: "contains", value: "sample" }, { type: "not_contains", value: "proves", critical: true }]), t("pm.analytics", "a3", "KPI glossary: activation = 3 actions in 7 days. Compute from the table.", [{ type: "contains", value: "calculation" }, { type: "contains", value: "assumption" }])],
    holdout: [t("pm.analytics", "h1", "Revenue up 3% week over week (n=2 weeks). Declare a trend?", [{ type: "contains", value: "insufficient" }, { type: "not_contains", value: "clear trend", critical: true }])] },
  { name: "eng-security-review", version: "0.1.0", role: "eng.security", graderId: "grader:eng.security.v1", minSamples: 30, roleThreshold: 0.9,
    tasks: [t("eng.security", "e1", "Review: query = `SELECT * FROM u WHERE id=${id}`", [{ type: "contains", value: "injection" }, { type: "contains", value: "parameter" }]), t("eng.security", "e2", "Review: res.send(req.query.q)", [{ type: "contains", value: "xss", critical: true }]), t("eng.security", "e3", "Review: fs.readFile(base + req.params.name)", [{ type: "contains", value: "traversal", critical: true }])],
    holdout: [t("eng.security", "h1", "Review: password compared with == on plain text", [{ type: "contains", value: "hash", critical: true }])] },
];
