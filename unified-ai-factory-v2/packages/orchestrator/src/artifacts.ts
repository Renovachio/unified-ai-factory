import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Sql } from "@factory/db";

export interface StoredArtifact { digest: string; uri: string; bytes: number }

/** Content-addressed, write-once store. The digest is always computed here (agent-supplied digests are untrusted). */
export class FileArtifactStore {
  constructor(private readonly root: string) {}
  private pathFor(hex: string) { return join(this.root, "sha256", hex.slice(0, 2), hex); }
  put(data: Uint8Array | string): StoredArtifact {
    const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
    const hex = createHash("sha256").update(buf).digest("hex");
    const p = this.pathFor(hex);
    if (!existsSync(p)) {
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, buf, { mode: 0o444 });
      renameSync(tmp, p); // atomic publish
    }
    return { digest: `sha256:${hex}`, uri: `file://${p}`, bytes: buf.length };
  }
  /** Removes an artifact (retention and erasure). Idempotent: returns false when it was already absent. */
  delete(digest: string): boolean {
    const hex = digest.replace(/^sha256:/, "");
    const p = this.pathFor(hex);
    if (!existsSync(p)) return false;
    chmodSync(p, 0o644);
    unlinkSync(p);
    return true;
  }
  /** Reads and re-verifies the digest (tamper detection). */
  get(digest: string): Buffer {
    const hex = digest.replace(/^sha256:/, "");
    const buf = readFileSync(this.pathFor(hex));
    if (createHash("sha256").update(buf).digest("hex") !== hex) throw new Error(`artifact ${digest} failed integrity check`);
    return buf;
  }
}

export async function recordArtifact(sql: Sql, a: { jobId: string; kind: string; stored: StoredArtifact; runId?: string | null }): Promise<void> {
  await sql`INSERT INTO artifacts (job_id, run_id, kind, digest, storage_uri, byte_length, redaction_status)
    VALUES (${a.jobId}, ${a.runId ?? null}, ${a.kind}, ${a.stored.digest}, ${a.stored.uri}, ${a.stored.bytes}, 'clean')
    ON CONFLICT (job_id, kind, digest) DO NOTHING`;
}
