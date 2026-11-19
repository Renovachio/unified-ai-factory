# Dispatch pilot — 2026-11-19T15:29:55.521Z

## 1. Real authorized pilot: gate check
- [ ] runtime available (0 configured)
- [ ] model qualified for builder role (0 qualification record(s))
- [ ] provider authorization recorded (0 approval(s))
- [ ] a worker is registered and heartbeating (0 active)
- [x] a GitHub-linked project exists (1 project(s))

**REAL PILOT: BLOCKED** by 4 unmet gate(s): runtime available; model qualified for builder role; provider authorization recorded; a worker is registered and heartbeating.

## 2. Deliberately failing pilot (gates unmet -> must NOT execute)
- Submitted job 45391006 (state QUEUED).
- After 8s: state **QUEUED**, PR none, events: request.received, job.accepted
- PASS (blocks safely): the job was accepted but nothing executed — no runtime, no agent run, no branch/PR.
- Cleanup: job 45391006 cancelled.
