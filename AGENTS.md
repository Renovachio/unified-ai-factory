# Agent rules — read before every task

You are implementing the Unified AI Software Factory from an original design. Do not copy code, prompts, scripts or assets from Marshal Factory or Zazen without documented permission and licensing review. Do not claim upstream source has been audited.

1. Work on exactly one `TASKS/<ID>.md` at a time. Confirm dependencies in `PROGRESS.md` have accepted evidence. Never mark a task done based on narrative alone.
2. Before changes: inspect repository state, write a short implementation plan, confirm exact files and test strategy. Do not overwrite unrelated changes.
3. Enforce **no metered model inference**: no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or equivalent provider keys; no paid inference SDK, hosted inference endpoint or token-based gateway. Subscription CLIs only where current provider terms *affirmatively* permit the intended orchestration; otherwise block them. Local/self-hosted inference is the permitted fallback. Never switch billing modes silently.
4. Runtime use must never expose host credentials to repository code. Use hardened isolation; Git worktrees alone are not isolation. Never bypass authentication, branch protection, security gates or human approval.
5. Apply migrations transactionally and reversibly where feasible. Make effects idempotent; enforce fencing tokens on worker state writes. Persist audit records with transitions.
6. Use TypeScript strict mode, typed boundary schemas, tests, and explicit error handling. Never parse untrusted JSON as trusted types without validation.
7. Validate the exact candidate commit SHA. Any change to SHA, base, policy, checks or review evidence invalidates affected approvals.
8. Do not run destructive commands or production deployment. Default to test repositories and mock credentials; ask for operator action on permissions, provider terms and secrets.
9. On failures: retry only transient failures within the prescribed budget; otherwise mark BLOCKED with evidence, don't falsely complete or alter criteria.
10. At end: run task-specific and regression tests, record commit SHA, commands, results, risks and next task in `evidence/<TASK-ID>/report.md`, update `PROGRESS.md` only on passing criteria.

## First agent instruction
Read `MASTER_PLAN.md`; start at `FND-001`. Do not implement the whole platform in one unreviewed pass. Present task completion evidence before moving to its dependent work order.
