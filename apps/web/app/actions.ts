"use server";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { api } from "../lib/api";

/** Approve / reject / request rework for the EXACT candidate the approver was looking at (SHA, base, policy digest are part of the form). */
export async function decide(form: FormData): Promise<void> {
  const id = String(form.get("jobId") ?? "");
  const session = await api<{ csrf: string | null }>("/session");
  if (!session.ok) redirect(`/jobs/${encodeURIComponent(id)}?error=${encodeURIComponent(session.error.title)}`);
  const r = await api(`/jobs/${encodeURIComponent(id)}/decisions`, {
    method: "POST", csrf: session.data.csrf ?? undefined, idempotencyKey: String(form.get("key") || randomUUID()),
    body: { decision: String(form.get("decision")), headSha: String(form.get("headSha")), baseSha: String(form.get("baseSha")), policyDigest: String(form.get("policyDigest")), expectedVersion: Number(form.get("expectedVersion")), ...(form.get("reason") ? { reason: String(form.get("reason")) } : {}) },
  });
  redirect(`/jobs/${encodeURIComponent(id)}${r.ok ? "" : `?error=${encodeURIComponent(r.error.detail ?? r.error.title)}`}`);
}
