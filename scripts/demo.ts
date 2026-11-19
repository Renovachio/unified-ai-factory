// LOCAL DEMO ONLY. Starts a throwaway Postgres, migrates it, seeds SYNTHETIC data through the real API, serves /api on 127.0.0.1:8787
// and (unless --no-web) the dashboard on 127.0.0.1:3000. It uses a demo authenticator that trusts a `demo_user` cookie / `x-demo-user` header,
// which exists only in this script and only on loopback: it must never be reused in a deployment. Nothing here talks to GitHub, a model or the internet.
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, migrateUp } from "../packages/db/src/index";
import { startTempCluster } from "../packages/db/src/testing";
import { makeWritable, ReportSigner } from "../packages/skills/src/index";
import { createApi, type Authenticator } from "../apps/api/src/index";
import { makeZip } from "../packages/skills/tests/zip-helper";

const withWeb = !process.argv.includes("--no-web");
const API = 8787, WEB = 3000;
const cluster = process.env.DATABASE_URL ? null : startTempCluster();
const sql = connect(process.env.DATABASE_URL ?? cluster!.url.replace(/\/postgres$/, "/postgres"));
await migrateUp(sql);
const dir = mkdtempSync(join(tmpdir(), "factory-demo-"));

const demoAuth: Authenticator = { async authenticate(req) {
  const who = req.headers.get("x-demo-user") ?? /(?:^|;\s*)demo_user=([a-z_]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
  return who ? { subject: who, via: "bearer" as const } : null;
} };
const [org] = await sql`INSERT INTO organizations (name) VALUES ('Demo org') RETURNING id`;
const USERS = [["viewer", "viewer"], ["editor", "editor"], ["operator", "operator"], ["approver", "approver"], ["admin", "admin"]] as const;
for (const [sub, role] of USERS) await sql`INSERT INTO users (organization_id, auth_subject, role) VALUES (${org!.id}, ${sub}, ${role}) ON CONFLICT DO NOTHING`;
const api = createApi({ sql, authenticator: demoAuth, rateLimit: { capacity: 1000, refillPerSec: 1000 }, allowedOrigins: [`http://127.0.0.1:${WEB}`],
  skills: { quarantineDir: join(dir, "q"), scratchDir: join(dir, "s"), policy: { version: "demo-1", allowedLicenses: ["MIT"], deniedHosts: ["api.anthropic.com", "api.openai.com"] }, signer: new ReportSigner("demo") } });
let k = 0;
const call = async (who: string, method: string, path: string, body?: unknown, zip?: Buffer) => {
  const h: Record<string, string> = { "x-demo-user": who, ...(method === "POST" ? { "idempotency-key": `seed-${++k}-${crypto.randomUUID()}` } : {}) };
  if (zip) h["content-type"] = "application/zip"; else if (body !== undefined) h["content-type"] = "application/json";
  const r = await api(new Request(`http://demo/api/v2${path}`, { method, headers: h, ...(zip ? { body: zip } : body !== undefined ? { body: JSON.stringify(body) } : {}) }));
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const MD = (n: string, d: string) => `---\nname: ${n}\ndescription: ${d}\nlicense: MIT\nruntimes: [local_model]\nallowed-tools: [Read]\ndomains: [product]\nproduces: [document]\n---\nSynthetic demo skill. Follow the steps and cite sources.\n`;
const zipOf = (n: string, d: string) => makeZip([{ name: `${n}/SKILL.md`, data: MD(n, d) }]);

// Seed (all synthetic): one approved+active skill, one validated skill awaiting a human decision, one hostile archive that is rejected.
const a = await call("editor", "POST", "/skills/imports", undefined, zipOf("story-writer", "Write user stories from a PRD with acceptance criteria"));
const reqA = await call("operator", "POST", "/approvals", { versionId: a.json.versionId, operation: "activate" });
await call("approver", "POST", `/approvals/${reqA.json.requestId}/decision`, { decision: "approved", digest: reqA.json.targetDigest, permissionDigest: reqA.json.permissionDigest });
await call("operator", "POST", "/activations", { approvalId: reqA.json.requestId, expectedRevision: 0 });
const b = await call("editor", "POST", "/skills/imports", undefined, zipOf("prd-reviewer", "Review a PRD for missing non-goals and metrics"));
await call("operator", "POST", "/approvals", { versionId: b.json.versionId, operation: "activate" });
const evil = await call("editor", "POST", "/skills/imports", undefined, makeZip([{ name: "../../etc/evil", data: "x" }]));
const [sig] = await sql`INSERT INTO improvement_signals (organization_id, kind, intent_key, evidence_digest, anonymized, opted_in) VALUES (${org!.id}, 'defect', 'prd-missing-nonoals', ${"sha256:" + "1".repeat(64)}, true, true) RETURNING id`;
const [tv] = await sql`SELECT digest FROM skill_versions WHERE organization_id = ${org!.id} AND slug = 'story-writer'`;
await sql`INSERT INTO improvement_proposals (organization_id, dedupe_key, target_digest, signal_ids, problem, hypothesis, requested_action, risk) VALUES (${org!.id}, 'demo', ${tv!.digest}, ${[sig!.id]}::uuid[], 'Stories omit non-goals (synthetic example)', 'Adding a non-goals instruction will raise the checklist pass rate', 'revise_skill', 'low')`;

const server = Bun.serve({ port: API, hostname: "127.0.0.1", async fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/demo/login") { // sets the demo identity cookie (shared with the web port: cookies ignore ports), then goes to the dashboard
    const as = u.searchParams.get("as") ?? "";
    if (!USERS.some(([s]) => s === as)) return new Response(`<h1>Demo login</h1>${USERS.map(([s, r]) => `<p><a href="/demo/login?as=${s}">${s}</a> (${r})</p>`).join("")}`, { headers: { "content-type": "text/html" } });
    return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${WEB}/skills`, "set-cookie": `demo_user=${as}; Path=/; SameSite=Lax` } });
  }
  return api(req);
}, idleTimeout: 60 });

let web: ReturnType<typeof Bun.spawn> | undefined;
if (withWeb) web = Bun.spawn(["bunx", "next", "dev", "-H", "127.0.0.1", "-p", String(WEB)], { cwd: join(import.meta.dir, "../apps/web"), env: { ...process.env, FACTORY_API_URL: `http://127.0.0.1:${API}`, APP_ORIGIN: `http://127.0.0.1:${WEB}` }, stdout: "inherit", stderr: "inherit" });

console.log(`
Demo is up (synthetic data, local only).
  Sign in as someone:  http://127.0.0.1:${API}/demo/login        (viewer, editor, operator, approver, admin)
  Dashboard:           http://127.0.0.1:${WEB}/skills   and   /improvements
  Seed result:         story-writer ${a.status}->active, prd-reviewer ${b.status} awaiting approval, hostile zip -> ${evil.status} (rejected)
Try the API:
  curl -s -H 'x-demo-user: editor' http://127.0.0.1:${API}/api/v2/skills
  # approve prd-reviewer as a DIFFERENT user than the requester, then activate:
  curl -s -H 'x-demo-user: approver' -H 'content-type: application/json' -H 'idempotency-key: d1' -d '{"decision":"approved","digest":"<targetDigest>","permissionDigest":"<permissionDigest>"}' http://127.0.0.1:${API}/api/v2/approvals/<requestId>/decision
Ctrl-C to stop and delete everything.`);
const stop = () => { web?.kill(); server.stop(true); void sql.end({ timeout: 1 }).finally(() => { cluster?.stop(); makeWritable(join(dir, "q")); rmSync(dir, { recursive: true, force: true }); process.exit(0); }); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
