import { createHash } from "node:crypto";

/**
 * Pure domain rules for canonical memory (MEM-01). No I/O here. The lifecycle matrix is mirrored in SQL by
 * memory_transition_allowed() in migration 0017; a DB test asserts the two agree on every pair.
 */

export const MEMORY_KINDS = ["decision", "requirement", "fact", "constraint", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MEMORY_STATUSES = ["proposed", "approved", "rejected", "superseded", "revoked", "deleted"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const MEMORY_SENSITIVITIES = ["public", "internal", "confidential", "restricted"] as const;
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];

/** Legal lifecycle. `deleted` is terminal. `approved` is reachable only through a human approval (see lifecycle.ts). */
export const MEMORY_TRANSITIONS: Readonly<Record<MemoryStatus, readonly MemoryStatus[]>> = {
  proposed: ["approved", "rejected", "revoked", "deleted"],
  approved: ["superseded", "revoked", "deleted"],
  rejected: ["deleted"],
  superseded: ["deleted"],
  revoked: ["deleted"],
  deleted: [],
};

/** Statuses from which a memory may still be used as current knowledge. Everything else is historical or erased. */
export const USABLE_STATUSES: readonly MemoryStatus[] = ["approved"];

export const MAX_CLAIM_CHARS = 4000;

/** Roles from the existing auth model (apps/api/src/auth.ts ROLES). */
export const PROPOSER_ROLES = ["editor", "operator", "approver", "admin"] as const;
export const APPROVER_ROLES = ["approver", "admin"] as const;
/** May revoke sources and erase memories created by others. */
export const STEWARD_ROLES = ["approver", "admin", "security_officer"] as const;
export const READER_ROLES = ["viewer", "editor", "operator", "approver", "admin", "security_officer"] as const;

export type MemoryErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "WRONG_STATE"
  | "SELF_APPROVAL"
  | "NO_SOURCE"
  | "SOURCE_REVOKED"
  | "SCOPE_MISMATCH"
  | "INVALID_CLAIM"
  | "DB_REJECTED"
  | "CONSENT_REQUIRED"
  | "SOURCE_UNVERIFIED"
  | "SOURCE_TOO_LARGE"
  | "NOT_INGESTIBLE"
  | "INVALID_QUERY"
  | "INVALID_ROLE"
  | "ROLE_CAP_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "PACK_NOT_FOUND"
  | "PACK_INVALID"
  | "PACK_INTEGRITY";

export class MemoryError extends Error {
  constructor(readonly code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

export function canTransition(from: MemoryStatus, to: MemoryStatus): boolean {
  return MEMORY_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: MemoryStatus, to: MemoryStatus): void {
  if (!canTransition(from, to)) throw new MemoryError("ILLEGAL_TRANSITION", `memory cannot move from ${from} to ${to}`);
}

/** Whitespace-normalised form used for deduplication. The stored claim keeps the author's text. */
export function normalizeClaim(claim: string): string {
  return claim.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

export function claimHash(claim: string): string {
  return createHash("sha256").update(normalizeClaim(claim), "utf8").digest("hex");
}

/** Rejects empty, oversized or NUL-bearing claims. Other text is kept verbatim: it is data and is never executed. */
export function validateClaim(claim: string): string {
  if (typeof claim !== "string") throw new MemoryError("INVALID_CLAIM", "claim must be text");
  if (claim.trim().length === 0) throw new MemoryError("INVALID_CLAIM", "claim is empty");
  if (claim.length > MAX_CLAIM_CHARS) throw new MemoryError("INVALID_CLAIM", `claim exceeds ${MAX_CLAIM_CHARS} characters`);
  if (claim.includes("\u0000")) throw new MemoryError("INVALID_CLAIM", "claim contains a NUL byte");
  return claim;
}

export function isUsable(status: MemoryStatus, revokedSourceCount: number): boolean {
  // Fail closed: one revoked source makes the memory unusable even if its status was not yet updated.
  return USABLE_STATUSES.includes(status) && revokedSourceCount === 0;
}
