import { cookies, headers } from "next/headers";

export interface ApiError { status: number; title: string; detail?: string }

/** Server-side call to the factory API, forwarding the viewer's own session cookie (the browser never talks to the API with a service token). */
export async function api<T>(path: string, init: { method?: string; body?: unknown; csrf?: string | undefined; idempotencyKey?: string | undefined } = {}): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  const base = process.env.FACTORY_API_URL ?? "http://127.0.0.1:8787";
  const jar = await cookies();
  const h = await headers();
  const cookie = jar.getAll().map((c) => `${c.name}=${c.value}`).join("; ");
  const res = await fetch(`${base}/api/v1${path}`, {
    method: init.method ?? "GET", cache: "no-store",
    headers: {
      ...(cookie ? { cookie } : {}), ...(h.get("authorization") ? { authorization: h.get("authorization") as string } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(process.env.APP_ORIGIN ? { origin: process.env.APP_ORIGIN } : {}),
      ...(init.csrf ? { "x-csrf-token": init.csrf } : {}), ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  }).catch(() => null);
  if (!res) return { ok: false, error: { status: 0, title: "API unreachable" } };
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return { ok: false, error: { status: res.status, title: String(json.title ?? "Error"), ...(json.detail ? { detail: String(json.detail) } : {}) } };
  return { ok: true, data: json as T };
}
