# Memory retention runbook (Adaptive Memory v2.5)

Status: draft for operator review. The policy numbers below are the operator's decisions (MEM-05); the backup section is a
statement of what the system cannot do, which the operator's own backup procedure must cover.

## Policy

| Record | Rule |
|---|---|
| Proposed, never approved | Erased 90 days after creation |
| Rejected | Erased 30 days after rejection |
| Context pack text (rendered context that copies claims) | Deleted 30 days after the pack was created; the pack row keeps only ids and digests |
| Approved | Never expires automatically. Erased only when a new approval overlaps it and the approver names it for erasure. A steward cannot erase approved memory directly (see the open decision below) |

Overlap (conflict) is a textual signal: same kind, different claim, and a word-set similarity (intersection over union) of at least
0.5, with at least five distinct words on each side. It does not decide whether two claims contradict. A person decides.

## Running the sweep

The sweep is `scripts/memory-retention.ts`. It is not installed as a service or scheduled job. Operators choose one of:

- Scheduled: a cron entry such as `0 3 * * * cd <repo> && DATABASE_URL=... DISPATCH_ARTIFACT_ROOT=... DISPATCH_RETENTION_STEWARD_ID=... <bun> scripts/memory-retention.ts >> <log> 2>&1`
- Foreground: `... bun scripts/memory-retention.ts --every-hours 24`

Required environment:
- `DATABASE_URL`: a connection for the control role (`factory_control`), which has the memory write grants.
- `DISPATCH_ARTIFACT_ROOT`: the same artifact root as the pack text store. A different root means pack text is never found or removed.
- `DISPATCH_RETENTION_STEWARD_ID`: an enabled user with the approver, admin or security_officer role. Every erasure is attributed to this user.

Each run writes one audit row (`memory.retention`) and prints one JSON line per run, with a per-project breakdown inside it. Check the log after the first run.

## Backups: what erasure does and does not do

Erasure removes memory content from the live database, the search index, and the stored pack text. It does **not** remove
content from backups or replicas that already contain it. Those copies persist until the backup retention expires.

The operator's backup procedure must state, and the operator must confirm:
1. The backup retention period (for example, 35 days). Erased content can exist in backups until the last backup containing it expires.
2. Whether backups are encrypted, and who holds the keys.
3. How a restore interacts with erasure: a restore brings back content that was erased after the backup was taken. After any
   restore, re-run the sweep and check that erased memories are still erased before the restored system serves users.
4. Whether a privacy request requires expiring specific backups early. If it does, that is a manual procedure, not something this system does.

Do not tell a data subject that erasure is instant or complete. The accurate statement is: removed from live systems at the
time of erasure; removed from backups when the backups expire.

## Verifying an erasure

For an erased memory:
- `memory_records.claim` is empty and `status` is `deleted`;
- no row exists in `memory_index` for it;
- no stored pack text contains it (the pack rows remain, and resolving them returns not-found);
- a tombstone row records the erasure reason, without the content.

## Known limits

- Approval conflicts are checked against approved memory only. Two proposals that overlap are not flagged until one is approved.
- The steward who runs the sweep is named in the audit trail; the affected memory's author is not asked before an erasure by the sweep.
- The sweep writes its audit row after its erasures, outside one transaction. A failure in the middle leaves the completed erasures (each with its own audit trail) and no sweep row. Re-running the sweep finishes the work.
- Conflict checks read every approved memory of the same kind in the project. Large projects make approval slower; there is no silent cap.

## Open decision

A steward cannot erase approved memory directly. If a legal or privacy request requires erasing approved memory that no new approval overlaps, the operator must decide how that is handled (for example, a separate, audited procedure). Until that decision is made, that request cannot be served by this system.
- Pack text for memories erased before the sweep existed is removed only when the sweep next runs.

Note for Dispatch local mode: the pack text lives under `<DISPATCH_HOME>/memory-packs`, so `DISPATCH_ARTIFACT_ROOT` for the sweep must be exactly that folder, or the sweep will not delete it.
