"use server";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
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

/** Engage the global auto-merge kill switch (any operator). Releasing it is deliberately NOT offered here: it needs an administrator through the API. */
export async function killAutoMerge(form: FormData): Promise<void> {
  const session = await api<{ csrf: string | null }>("/session");
  if (!session.ok) redirect(`/auto-merge?error=${encodeURIComponent(session.error.title)}`);
  const r = await api("/auto-merge/kill", { method: "POST", csrf: session.data.csrf ?? undefined, body: { reason: String(form.get("reason") ?? "") } });
  redirect(`/auto-merge${r.ok ? "" : `?error=${encodeURIComponent(r.error.detail ?? r.error.title)}`}`);
}

/** End the browser session: revoke it server-side (the cookie alone is not the source of truth), then drop the cookie from this browser. */
export async function signOut(): Promise<void> {
  const session = await api<{ csrf: string | null }>("/session");
  if (session.ok) await api("/auth/logout", { method: "POST", csrf: session.data.csrf ?? undefined });
  const jar = await cookies();
  for (const n of ["factory_session", "__Host-factory_session"]) jar.delete(n);
  redirect("/login");
}
