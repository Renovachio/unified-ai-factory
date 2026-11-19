import { randomUUID } from "node:crypto";
import { sseResponse, type Sql } from "@factory/db";
import { answerQuestions, FeedbackRejected } from "@factory/intake";
import { AutoMergeRefused, DecisionRejected, recordDecision, type AutoMergeController, type ReviewPort } from "@factory/orchestrator";
import { receiveGitHubWebhook } from "@factory/scm";
import { assertCsrf, require_, resolveActor, type Actor, type Authenticator } from "./auth";
import { readJson, readRaw } from "./body";
import { pendingCookies, type OidcLogin } from "./login";
import { cancelJob, createJob, getJob, listEvents, listJobs, requireIdempotencyKey, type JsonResult } from "./jobs";
import { pauseJob, quarantineJob, releaseQuarantine, resumeJob, workerAction } from "./operator";
import { ApiProblem, problemResponse, problems, SECURITY_HEADERS } from "./problem";
import { jobTimeline, listArtifacts, listAudit, listWorkers, policyView, usageReport } from "./readmodels";
import { RateLimiter } from "./ratelimit";
import { registryProblem, registryRoutes, type SkillsConfig } from "./registry";

export interface ApiConfig {
  sql: Sql;
  authenticator: Authenticator;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  githubWebhookSecret?: string;
  rateLimit?: { capacity: number; refillPerSec: number };
  /** Needed by POST /jobs/:id/decisions to rebuild the current evidence binding (reviewer routing). */
  review?: Pick<ReviewPort, "requiredRoles">;
  /** Rollout controls for opt-in auto-merge (kill switch, per-repository opt-in, hold). */
  autoMerge?: AutoMergeController;
  /** Interactive OIDC login (authorization code + PKCE) and server-side sessions. */
  login?: OidcLogin;
  /** v2.2 skill/agent registry: quarantined imports, exact-digest approvals, CAS activation. Routes under /api/v2. */
  skills?: SkillsConfig;
  /** Dispatch local mode: one-time browser entry (loopback only). */
  local?: { entry: LocalBrowserEntry };
  ready?: () => Promise<boolean>;
  log?: (line: Record<string, unknown>) => void;
}

import type { LocalBrowserEntry } from "./local";
import { dispatchRoutes } from "./dispatch";
const BASE = "/api/v1";
const BASE2 = "/api/v2";
const json = (r: JsonResult): Response => new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { ...(r.body === undefined ? {} : { "content-type": "application/json" }), ...SECURITY_HEADERS, ...(r.headers ?? {}) } });

/** Framework-free request handler (Web `Request` -> `Response`); mounted by Bun.serve in server.ts and called directly by tests. */
export function createApi(cfg: ApiConfig): (req: Request) => Promise<Response> {
  const maxBody = cfg.maxBodyBytes ?? 256 * 1024;
  const limiter = new RateLimiter(cfg.rateLimit?.capacity ?? 120, cfg.rateLimit?.refillPerSec ?? 2);
  const log = cfg.log ?? (() => undefined);

  async function authn(req: Request): Promise<Actor> {
    const id = await cfg.authenticator.authenticate(req);
    if (!id) throw problems.unauthorized();
    const actor = await resolveActor(cfg.sql, id);
    const wait = limiter.take(actor.userId);
    if (wait) throw problems.rateLimited(wait);
    return actor;
  }
  const mutating = (req: Request, actor: Actor) => assertCsrf(req, actor, cfg.allowedOrigins ?? []);

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const m = req.method;
    if (path === `${BASE}/local/enter`) { // one-time code -> cookie session; only exists in Dispatch local mode
      if (!cfg.local) throw problems.notFound("no such route");
      if (m !== "GET") throw problems.methodNotAllowed(["GET"]);
      return cfg.local.entry.enter(req);
    }
    if (path === `${BASE2}/dispatch/browser-code`) { // CLI (local owner bearer token) asks for a one-time dashboard sign-in code
      if (!cfg.local) throw problems.notFound("no such route");
      if (m !== "POST") throw problems.methodNotAllowed(["POST"]);
      const a = await authn(req);
      if (a.via !== "bearer" || a.subject !== "dispatch-local-owner") throw problems.forbidden("only the local owner token may request a browser code");
      return json({ status: 200, body: { code: cfg.local.entry.mint(), expiresInSeconds: 60 } });
    }
    if (path.startsWith(`${BASE2}/`)) {
      const sub = path.slice(BASE2.length);
      const hit = [...registryRoutes, ...dispatchRoutes].filter((r) => r.pattern.test(sub));
      if (hit.length === 0) throw problems.notFound("no such route");
      const route2 = hit.find((r) => r.method === m);
      if (!route2) throw problems.methodNotAllowed([...new Set(hit.map((r) => r.method))]);
      const actor = await authn(req); // authenticate before any state is revealed
      try {
        const r = await route2.handler({ req, sql: cfg.sql, actor, cfg: cfg.skills, maxBody, mutating: () => mutating(req, actor), key: () => requireIdempotencyKey(req) });
        return json(r);
      } catch (e) { const p = registryProblem(e); if (p) throw p; throw e; }
    }
    if (path === `${BASE}/health/live`) return json({ status: 200, body: { status: "ok" } });
    if (path === `${BASE}/health/ready`) {
      const ok = await (cfg.ready ?? (async () => { await cfg.sql`SELECT 1`; return true; }))().catch(() => false);
      return json({ status: ok ? 200 : 503, body: { status: ok ? "ready" : "unavailable" } });
    }
    if (path === `${BASE}/integrations/github/webhook`) {
      if (m !== "POST") throw problems.methodNotAllowed(["POST"]);
      if (!cfg.githubWebhookSecret) throw new ApiProblem({ status: 503, code: "not-configured", title: "Webhook receiver not configured" });
      const raw = await readRaw(req, 5 * 1024 * 1024);
      const r = await receiveGitHubWebhook(cfg.sql, { rawBody: raw, signature: req.headers.get("x-hub-signature-256"), deliveryId: req.headers.get("x-github-delivery"), eventName: req.headers.get("x-github-event"), secret: cfg.githubWebhookSecret });
      if (r.status === "rejected") throw r.reason === "bad-signature" ? problems.unauthorized("invalid webhook signature") : problems.badRequest(`webhook rejected: ${r.reason}`);
      return json({ status: 202, body: { status: r.status } });
    }
    if (path === `${BASE}/auth/login` || path === `${BASE}/auth/callback` || path === `${BASE}/auth/logout`) {
      if (!cfg.login) throw new ApiProblem({ status: 503, code: "not-configured", title: "Interactive login is not configured" });
      if (path.endsWith("/login") || path.endsWith("/callback")) {
        if (m !== "GET") throw problems.methodNotAllowed(["GET"]);
        return path.endsWith("/login") ? cfg.login.start(req) : cfg.login.callback(req);
      }
      if (m !== "POST") throw problems.methodNotAllowed(["POST"]);
      const a = await authn(req);
      if (a.via !== "session") throw problems.badRequest("logout applies to browser sessions");
      mutating(req, a);
      return cfg.login.logout(req, a.userId, a.orgId);
    }
    if (path === `${BASE}/session`) {
      if (m !== "GET") throw problems.methodNotAllowed(["GET"]);
      const a = await authn(req);
      return json({ status: 200, body: { userId: a.userId, role: a.role, via: a.via, csrf: a.csrf ?? null } });
    }
    if (path === `${BASE}/auto-merge` || path === `${BASE}/auto-merge/kill` || path === `${BASE}/auto-merge/disarm` || /^\/api\/v1\/repositories\/[^/]+\/auto-merge$/.test(path)) {
      const a = await authn(req); // authenticate before revealing configuration state
      if (!cfg.autoMerge) throw new ApiProblem({ status: 503, code: "not-configured", title: "Auto-merge controls are not configured" });
      const ctl = cfg.autoMerge;
      const reason = async () => { const { value } = await readJson(req, maxBody); const r = (value as { reason?: unknown })?.reason; if (typeof r !== "string" || r.length < 1 || r.length > 1000) throw problems.unprocessable("reason (1..1000 characters) is required"); return { reason: r, body: value as Record<string, unknown> }; };
      try {
        if (path === `${BASE}/auto-merge`) {
          if (m !== "GET") throw problems.methodNotAllowed(["GET"]);
          require_(a, "automerge:read");
          return json({ status: 200, body: await ctl.status(a.orgId) });
        }
        if (m !== "POST") throw problems.methodNotAllowed(["POST"]);
        mutating(req, a);
        if (path.endsWith("/kill")) { require_(a, "automerge:kill"); const { reason: r } = await reason(); await ctl.kill(a.userId, a.orgId, r); return json({ status: 202, body: { killSwitch: true } }); }
        if (path.endsWith("/disarm")) { require_(a, "automerge:configure"); const { reason: r } = await reason(); await ctl.disarm(a.userId, a.orgId, r); return json({ status: 202, body: { killSwitch: false } }); }
        require_(a, "automerge:configure");
        const repoId = (path.split("/")[4]) as string;
        if (!/^[0-9a-f-]{36}$/i.test(repoId)) throw problems.notFound("repository not found");
        const { reason: r, body } = await reason();
        const action = body.action;
        if (action === "enable") {
          const out = await ctl.enableRepo({ actor: a.userId, orgId: a.orgId, repositoryId: repoId, pilotReport: body.pilotReport, ...(Array.isArray(body.allowedRisks) ? { allowedRisks: body.allowedRisks as Array<"LOW" | "MEDIUM"> } : {}), ...(Array.isArray(body.allowedPathGlobs) ? { allowedPathGlobs: body.allowedPathGlobs as string[] } : {}), ...(typeof body.maxPerDay === "number" ? { maxPerDay: body.maxPerDay } : {}), ...(typeof body.cooldownMinutes === "number" ? { cooldownMinutes: body.cooldownMinutes } : {}) });
          return json({ status: 202, body: { enabled: true, signoffDigest: out.signoffDigest } });
        }
        if (action === "disable") { await ctl.disableRepo(a.userId, a.orgId, repoId, r); return json({ status: 202, body: { enabled: false } }); }
        if (action === "rearm") { await ctl.rearm(a.userId, a.orgId, repoId, r); return json({ status: 202, body: { tripped: false } }); }
        throw problems.unprocessable('action must be "enable", "disable" or "rearm"');
      } catch (e) {
        if (e instanceof AutoMergeRefused) throw e.code === "not-found" ? problems.notFound(e.message) : e.code === "pilot-invalid" ? new ApiProblem({ status: 422, code: "pilot-invalid", title: "Unprocessable Content", detail: e.message, extra: { reasons: e.reasons } }) : problems.unprocessable(e.message);
        throw e;
      }
    }
    if (path === `${BASE}/usage`) {
      if (m !== "GET") throw problems.methodNotAllowed(["GET"]);
      const a = await authn(req); require_(a, "usage:read");
      return json({ status: 200, body: await usageReport(cfg.sql, a, url.searchParams) });
    }
    if (path === `${BASE}/audit`) {
      if (m !== "GET") throw problems.methodNotAllowed(["GET"]);
      const a = await authn(req); require_(a, "audit:read");
      return json({ status: 200, body: await listAudit(cfg.sql, a, url.searchParams) });
    }
    if (path === `${BASE}/workers`) {
      if (m !== "GET") throw problems.methodNotAllowed(["GET"]);
      const a = await authn(req); require_(a, "worker:read");
      return json({ status: 200, body: await listWorkers(cfg.sql, a) });
    }
    const wk = /^\/api\/v1\/workers\/([^/]+)\/(drain|quarantine|activate)$/.exec(path);
    if (wk) {
      if (m !== "POST") throw problems.methodNotAllowed(["POST"]);
      const a = await authn(req); require_(a, "worker:manage"); mutating(req, a);
      const { value } = await readJson(req, maxBody);
      const r = await workerAction(cfg.sql, a, wk[1] as string, wk[2] as string, value);
      return json(r);
    }
    if (!path.startsWith(`${BASE}/jobs`)) throw problems.notFound("no such route");
    const rest = path.slice(`${BASE}/jobs`.length);
    const actor = await authn(req);

    if (rest === "" || rest === "/") {
      if (m === "POST") {
        require_(actor, "job:create"); mutating(req, actor);
        const key = requireIdempotencyKey(req);
        const { value } = await readJson(req, maxBody);
        return json(await createJob(cfg.sql, actor, key, value));
      }
      if (m === "GET") { require_(actor, "job:read"); return json({ status: 200, body: await listJobs(cfg.sql, actor, url.searchParams) }); }
      throw problems.methodNotAllowed(["GET", "POST"]);
    }
    const seg = rest.split("/").filter(Boolean);
    const id = seg[0] as string;
    if (seg.length === 1) {
      if (m !== "GET") throw problems.methodNotAllowed(["GET"]);
      require_(actor, "job:read");
      const { detail, version } = await getJob(cfg.sql, actor, id);
      const etag = `"${version}"`;
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag, ...SECURITY_HEADERS } });
      return json({ status: 200, body: detail, headers: { etag } });
    }
    if (seg.length === 2 && seg[1] === "events") {
      if (m !== "GET") throw problems.methodNotAllowed(["GET"]);
      require_(actor, "job:read");
      return json({ status: 200, body: await listEvents(cfg.sql, actor, id, url.searchParams) });
    }
    if (seg.length === 3 && seg[1] === "events" && seg[2] === "stream") {
      if (m !== "GET") throw problems.methodNotAllowed(["GET"]);
      require_(actor, "job:read");
      await getJob(cfg.sql, actor, id);
      const last = req.headers.get("last-event-id") ?? url.searchParams.get("afterSequence");
      const res = sseResponse(cfg.sql, { jobId: id, lastEventId: last, signal: req.signal });
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
      return res;
    }
    if (seg.length === 2 && seg[1] === "cancel") {
      if (m !== "POST") throw problems.methodNotAllowed(["POST"]);
      require_(actor, "job:cancel"); mutating(req, actor);
      requireIdempotencyKey(req);
      const { value } = await readJson(req, maxBody);
      return json(await cancelJob(cfg.sql, actor, id, value));
    }
    if (seg.length === 2 && (seg[1] === "timeline" || seg[1] === "artifacts" || seg[1] === "policy")) {
      if (m !== "GET") throw problems.methodNotAllowed(["GET"]);
      require_(actor, "job:read");
      const body = seg[1] === "timeline" ? await jobTimeline(cfg.sql, actor, id, url.searchParams) : seg[1] === "artifacts" ? await listArtifacts(cfg.sql, actor, id, url.searchParams) : await policyView(cfg.sql, actor, id);
      return json({ status: 200, body });
    }
    if (seg.length === 2 && seg[1] === "hold-auto-merge") {
      if (m !== "POST") throw problems.methodNotAllowed(["POST"]);
      require_(actor, "job:hold-auto"); mutating(req, actor);
      if (!cfg.autoMerge) throw new ApiProblem({ status: 503, code: "not-configured", title: "Auto-merge controls are not configured" });
      const { value } = await readJson(req, maxBody);
      const r = (value as { reason?: unknown })?.reason;
      if (typeof r !== "string" || r.length < 1 || r.length > 1000) throw problems.unprocessable("reason (1..1000 characters) is required");
      await getJob(cfg.sql, actor, id);
      await cfg.autoMerge.holdJob(actor.userId, actor.orgId, id, r);
      return json({ status: 202, body: { held: true } });
    }
    if (seg.length === 2 && ["pause", "resume", "quarantine", "release"].includes(seg[1] as string)) {
      if (m !== "POST") throw problems.methodNotAllowed(["POST"]);
      const perm = seg[1] === "pause" ? "job:pause" : seg[1] === "resume" ? "job:resume" : seg[1] === "quarantine" ? "job:quarantine" : "job:quarantine-release";
      require_(actor, perm); mutating(req, actor);
      const { value } = await readJson(req, maxBody);
      const fn = { pause: pauseJob, resume: resumeJob, quarantine: quarantineJob, release: releaseQuarantine }[seg[1] as "pause"];
      return json(await fn(cfg.sql, actor, id, value));
    }
    if (seg.length === 2 && seg[1] === "decisions") {
      if (m !== "POST") throw problems.methodNotAllowed(["POST"]);
      require_(actor, "job:decide"); mutating(req, actor);
      const key = requireIdempotencyKey(req);
      if (!cfg.review) throw new ApiProblem({ status: 503, code: "not-configured", title: "Decisions are not configured" });
      const { value } = await readJson(req, maxBody);
      const b = value as Record<string, unknown>;
      const allowed = new Set(["decision", "headSha", "baseSha", "policyDigest", "expectedVersion", "reason"]);
      if (!b || typeof b !== "object" || Object.keys(b).some((k) => !allowed.has(k)) || !["approve", "reject", "rework"].includes(b.decision as string) || typeof b.headSha !== "string" || typeof b.baseSha !== "string" || typeof b.policyDigest !== "string" || !Number.isInteger(b.expectedVersion) || (b.reason !== undefined && typeof b.reason !== "string"))
        throw problems.unprocessable("body must be {decision: approve|reject|rework, headSha, baseSha, policyDigest, expectedVersion, reason?}");
      await getJob(cfg.sql, actor, id);
      try {
        const r = await recordDecision(cfg.sql, cfg.review, { jobId: id, orgId: actor.orgId, actorId: actor.userId, idempotencyKey: key, decision: b.decision as "approve" | "reject" | "rework", headSha: b.headSha, baseSha: b.baseSha, policyDigest: b.policyDigest, expectedVersion: b.expectedVersion as number, reason: b.reason as string | undefined });
        return json({ status: 202, body: { decisionId: r.decisionId, state: r.state, version: r.version }, headers: { etag: `"${r.version}"`, ...(r.replayed ? { "idempotency-replayed": "true" } : {}) } });
      } catch (e) {
        if (e instanceof DecisionRejected) {
          if (e.code === "validation") throw problems.unprocessable(e.message);
          if (e.code === "not-found") throw problems.notFound(e.message);
          if (e.code === "self-approval") throw problems.forbidden(e.message);
          throw new ApiProblem({ status: 409, code: e.code, title: "Conflict", detail: e.message, ...(e.detail ? { extra: e.detail } : {}) });
        }
        throw e;
      }
    }
    if (seg.length === 2 && seg[1] === "feedback") {
      if (m !== "POST") throw problems.methodNotAllowed(["POST"]);
      require_(actor, "job:feedback"); mutating(req, actor);
      const { value } = await readJson(req, maxBody);
      const b = value as { message?: unknown; expectedVersion?: unknown };
      if (typeof b?.message !== "string" || !Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 1) throw problems.unprocessable("body must be {message: string, expectedVersion: integer >= 1}");
      await getJob(cfg.sql, actor, id); // org-scoped existence
      try {
        const r = await answerQuestions(cfg.sql, { jobId: id, actorId: actor.userId, message: b.message, expectedVersion: b.expectedVersion as number });
        return json({ status: 202, body: { state: "INTAKE", version: r.version }, headers: { etag: `"${r.version}"` } });
      } catch (e) {
        if (e instanceof FeedbackRejected) throw e.code === "too-long" ? problems.unprocessable(e.message) : problems.conflict(e.code, e.message);
        throw e;
      }
    }
    throw problems.notFound("no such route");
  }

  return async (req) => {
    const requestId = req.headers.get("x-request-id")?.slice(0, 64) || randomUUID();
    let res: Response;
    try {
      res = await route(req);
    } catch (e) {
      if (e instanceof ApiProblem) res = problemResponse(e.init, requestId);
      else {
        log({ level: "error", requestId, error: e instanceof Error ? e.message : String(e) }); // details stay server-side
        res = problemResponse({ status: 500, code: "internal", title: "Internal Server Error", detail: "unexpected error" }, requestId);
      }
    }
    res.headers.set("x-request-id", requestId);
    for (const c of pendingCookies.get(req) ?? []) res.headers.append("set-cookie", c); // session id rotation
    return res;
  };
}
