import { createHmac, timingSafeEqual } from "node:crypto";
import { appendEvent, type Sql } from "@factory/db";
import { digestOf } from "@factory/telemetry";
import { z } from "zod";

/** Constant-time check of GitHub's `X-Hub-Signature-256: sha256=<hex>` over the RAW body. */
export function verifyGitHubSignature(rawBody: Uint8Array | string, header: string | null | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const m = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
  if (!m) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(m[1] as string, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const PullRequestEvent = z.object({
  action: z.string(),
  number: z.number().int().positive(),
  repository: z.object({ id: z.number() }),
  pull_request: z.object({
    number: z.number().int().positive(),
    merged: z.boolean().optional(),
    state: z.string(),
    head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
    base: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/).optional() }).optional(),
  }),
});

export type WebhookResult =
  | { status: "rejected"; reason: "bad-signature" | "missing-delivery-id" | "malformed" }
  | { status: "duplicate" }
  | { status: "processed"; event: string; effects: string[] }
  | { status: "ignored"; event: string };

export interface WebhookInput {
  rawBody: Uint8Array | string;
  signature: string | null | undefined;
  deliveryId: string | null | undefined;
  eventName: string | null | undefined;
  secret: string;
}

/**
 * Signature-verified, replay-deduplicated webhook ingestion. Invalid signatures are NOT recorded (an attacker must not be able
 * to burn a real delivery id). Recording and processing share one transaction, so a failed processing attempt leaves no
 * delivery row and GitHub's redelivery is processed normally; concurrent duplicates are serialised by the unique key.
 */
export async function receiveGitHubWebhook(sql: Sql, input: WebhookInput): Promise<WebhookResult> {
  if (!verifyGitHubSignature(input.rawBody, input.signature, input.secret)) {
    await sql`INSERT INTO audit_entries (actor, action, resource, result, reason, digest)
      VALUES ('github-webhook', 'webhook.rejected', ${`delivery:${input.deliveryId ?? "?"}`}, 'denied', 'bad signature', ${digestOf({ d: input.deliveryId ?? null, at: Date.now() })})`;
    return { status: "rejected", reason: "bad-signature" };
  }
  if (!input.deliveryId || !/^[A-Za-z0-9-]{8,64}$/.test(input.deliveryId)) return { status: "rejected", reason: "missing-delivery-id" };
  const eventName = input.eventName ?? "unknown";
  let payload: unknown;
  try {
    payload = JSON.parse(typeof input.rawBody === "string" ? input.rawBody : Buffer.from(input.rawBody).toString("utf8"));
  } catch {
    return { status: "rejected", reason: "malformed" };
  }
  return sql.begin(async (tx) => {
    const [ins] = await tx<{ id: string }[]>`
      INSERT INTO webhook_deliveries (provider, delivery_id, signature_valid) VALUES ('github', ${input.deliveryId as string}, true)
      ON CONFLICT (provider, delivery_id) DO NOTHING RETURNING id`;
    if (!ins) return { status: "duplicate" } as const;
    const effects: string[] = [];
    if (eventName === "pull_request") {
      const parsed = PullRequestEvent.safeParse(payload);
      if (!parsed.success) throw new Error("malformed pull_request payload");
      const ev = parsed.data;
      const [pr] = await tx<{ job_id: string; head_sha: string }[]>`
        SELECT p.job_id, p.head_sha FROM pull_requests p JOIN repositories r ON r.id = p.repository_id
        WHERE r.provider = 'github' AND r.external_id = ${String(ev.repository.id)} AND p.pr_number = ${ev.pull_request.number} FOR UPDATE OF p`;
      if (pr) {
        if (ev.pull_request.head.sha !== pr.head_sha) {
          await tx`UPDATE pull_requests SET head_sha = ${ev.pull_request.head.sha}, updated_at = now() WHERE job_id = ${pr.job_id}`;
          await tx`UPDATE jobs SET head_sha = ${ev.pull_request.head.sha} WHERE id = ${pr.job_id}`;
          await appendEvent(tx, { jobId: pr.job_id, type: "pr.head_changed", source: "github", payload: { from: pr.head_sha, to: ev.pull_request.head.sha, action: ev.action } });
          effects.push("head_changed");
        }
        if (ev.action === "closed") {
          await appendEvent(tx, { jobId: pr.job_id, type: "pr.closed", source: "github", payload: { merged: ev.pull_request.merged ?? false, head_sha: ev.pull_request.head.sha } });
          effects.push("closed");
        }
      }
    } else if (eventName !== "ping") {
      await tx`UPDATE webhook_deliveries SET processed_at = now() WHERE id = ${ins.id}`;
      return { status: "ignored", event: eventName } as const;
    }
    await tx`UPDATE webhook_deliveries SET processed_at = now() WHERE id = ${ins.id}`;
    return { status: "processed", event: eventName, effects } as const;
  });
}
