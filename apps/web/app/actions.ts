"use server";
import { redirect } from "next/navigation";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { api } from "../lib/api";
import { routeCommand } from "../lib/command-route";

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

/** Command box: navigation only (see lib/command-route.ts). */
export async function runCommand(form: FormData): Promise<void> {
  const r = routeCommand(String(form.get("text") ?? "").slice(0, 500));
  redirect("to" in r ? r.to : `/?notice=${encodeURIComponent(r.notice)}`);
}

/** Pause / resume / cancel through the existing job endpoints, bound to the revision the user saw. Cancel additionally requires the typed id prefix. */
export async function jobControl(form: FormData): Promise<void> {
  const id = String(form.get("jobId") ?? ""); const op = String(form.get("op") ?? ""); const revision = Number(form.get("revision"));
  const back = (m?: string) => redirect(`/jobs/${encodeURIComponent(id)}${m ? `?error=${encodeURIComponent(m)}` : ""}`);
  if (!["pause", "resume", "cancel"].includes(op) || !Number.isInteger(revision) || revision < 1) back("Invalid request.");
  if (op === "cancel" && String(form.get("confirm") ?? "").trim().toLowerCase() !== id.slice(0, 8).toLowerCase()) back("Cancellation not confirmed: nothing was cancelled.");
  const session = await api<{ csrf: string | null }>("/session"); if (!session.ok) back(session.error.title);
  const r = await api(`/jobs/${encodeURIComponent(id)}/${op}`, { method: "POST", csrf: session.ok ? session.data.csrf ?? undefined : undefined, idempotencyKey: randomUUID(), body: { reason: "via dashboard", expectedVersion: revision } });
  back(r.ok ? undefined : r.error.detail ?? r.error.title);
}

/** Approve/reject a capability for the EXACT digests that were displayed. Does not activate; activation is a separate, revision-checked step. */
export async function decideCapability(form: FormData): Promise<void> {
  const id = String(form.get("requestId") ?? ""); const decision = String(form.get("decision") ?? "");
  const session = await api<{ csrf: string | null }>("/session");
  if (!session.ok || !["approved", "rejected"].includes(decision)) redirect(`/approvals?error=${encodeURIComponent(session.ok ? "Invalid decision." : session.error.title)}`);
  const r = await api(`/v2/approvals/${encodeURIComponent(id)}/decision`, { method: "POST", csrf: session.data.csrf ?? undefined, idempotencyKey: randomUUID(), body: { decision, digest: String(form.get("digest")), permissionDigest: String(form.get("permissionDigest")), note: String(form.get("note") ?? "").slice(0, 500) || undefined } });
  redirect(`/approvals${r.ok ? "" : `?error=${encodeURIComponent(r.error.detail ?? r.error.title)}`}`);
}
