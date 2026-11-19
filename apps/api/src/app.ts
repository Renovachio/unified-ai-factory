import { randomUUID } from "node:crypto";
import { sseResponse, type Sql } from "@factory/db";
import { answerQuestions, FeedbackRejected } from "@factory/intake";
import { DecisionRejected, recordDecision, type ReviewPort } from "@factory/orchestrator";
import { receiveGitHubWebhook } from "@factory/scm";
import { assertCsrf, require_, resolveActor, type Actor, type Authenticator } from "./auth";
import { readJson, readRaw } from "./body";
import { cancelJob, createJob, getJob, listEvents, listJobs, requireIdempotencyKey, type JsonResult } from "./jobs";
import { ApiProblem, problemResponse, problems, SECURITY_HEADERS } from "./problem";
import { RateLimiter } from "./ratelimit";

export interface ApiConfig {
  sql: Sql;
  authenticator: Authenticator;
  allowedOrigins?: string[];
  maxBodyBytes?: number;
  githubWebhookSecret?: string;
  rateLimit?: { capacity: number; refillPerSec: number };
  /** Needed by POST /jobs/:id/decisions to rebuild the current evidence binding (reviewer routing). */
  review?: Pick<ReviewPort, "requiredRoles">;
  ready?: () => Promise<boolean>;
  log?: (line: Record<string, unknown>) => void;
}

const BASE = "/api/v1";
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
    return res;
  };
}
