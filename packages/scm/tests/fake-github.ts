import { createPublicKey, createVerify } from "node:crypto";

export interface Req { method: string; path: string; perms?: Record<string, string> | undefined }
interface Pr { number: number; node_id: string; html_url: string; draft: boolean; state: string; merged: boolean; merge_commit_sha: string | null; head: { sha: string; ref: string }; base: { ref: string } }
export interface FakeCheck { name: string; status: string; conclusion: string | null }

/** Minimal in-memory GitHub REST API (just what the factory uses), served over real HTTP. */
export class FakeGitHub {
  readonly refs = new Map<string, string>([["main", "1".repeat(40)]]);
  readonly prs: Pr[] = [];
  readonly log: Req[] = [];
  readonly tokens = new Map<string, { perms: Record<string, string>; repos: string[] }>();
  private faults: Array<{ re: RegExp; status: number; count: number }> = [];
  onBeforeCreatePr: (() => void) | undefined;
  readonly checks = new Map<string, FakeCheck[]>();
  mergeCalls = 0;
  /** "timeout-after-merge": the merge happens but the response is a 504; "error-before-merge": 502 and nothing merged. */
  mergeFault: "timeout-after-merge" | "error-before-merge" | undefined;
  /** Simulates branch protection refusing the merge. */
  protectBase = false;
  private mergeN = 0;
  private server!: ReturnType<typeof Bun.serve>;
  private n = 0;
  constructor(private readonly publicKeyPem: string) {}
  get url() { return `http://127.0.0.1:${this.server.port}`; }
  start() { this.server = Bun.serve({ port: 0, fetch: (r) => this.handle(r) }); return this; }
  stop() { this.server.stop(true); }
  failNext(re: RegExp, status: number, count = 1) { this.faults.push({ re, status, count }); }
  addPr(head: string, sha: string, draft = false): Pr {
    const pr: Pr = { number: this.prs.length + 1, node_id: `PR_${this.prs.length + 1}`, html_url: `https://github.com/o/r/pull/${this.prs.length + 1}`, draft, state: "open", merged: false, merge_commit_sha: null, head: { sha, ref: head }, base: { ref: "main" } };
    this.prs.push(pr);
    return pr;
  }
  movePrHead(number: number, sha: string) { const p = this.prs.find((x) => x.number === number); if (p) { p.head.sha = sha; this.refs.set(p.head.ref, sha); } }
  externalMerge(number: number, sha = "ee".repeat(20)) { const p = this.prs.find((x) => x.number === number); if (p) { p.merged = true; p.state = "closed"; p.merge_commit_sha = sha; this.refs.set(p.base.ref, sha); } }
  private json(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }

  private async handle(req: Request): Promise<Response> {
    const u = new URL(req.url);
    const path = u.pathname;
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    const record: Req = { method: req.method, path: path + u.search };
    this.log.push(record);
    const fault = this.faults.find((f) => f.count > 0 && f.re.test(`${req.method} ${path}`));
    if (fault) { fault.count--; return this.json(fault.status, { message: "injected fault" }); }

    const inst = /^\/app\/installations\/([^/]+)\/access_tokens$/.exec(path);
    if (inst && req.method === "POST") {
      const jwt = token.split(".");
      if (jwt.length !== 3) return this.json(401, { message: "bad jwt" });
      const ok = createVerify("RSA-SHA256").update(`${jwt[0]}.${jwt[1]}`).verify(createPublicKey(this.publicKeyPem), Buffer.from(jwt[2] as string, "base64url"));
      if (!ok) return this.json(401, { message: "bad jwt signature" });
      const body = (await req.json()) as { repositories: string[]; permissions: Record<string, string> };
      const t = `ghs_fake${++this.n}${"x".repeat(20)}`;
      this.tokens.set(t, { perms: body.permissions, repos: body.repositories });
      record.perms = body.permissions;
      return this.json(201, { token: t, expires_at: new Date(Date.now() + 3600_000).toISOString() });
    }
    const t = this.tokens.get(token);
    if (!t) return this.json(401, { message: "Bad credentials" });
    record.perms = t.perms;
    const can = (perm: string, level: "read" | "write") => t.perms[perm] === "write" || (level === "read" && t.perms[perm] === "read");

    if (path === "/graphql" && req.method === "POST") {
      if (!can("pull_requests", "write")) return this.json(403, { message: "Resource not accessible by integration" });
      const b = (await req.json()) as { variables: { id: string } };
      const pr = this.prs.find((x) => x.node_id === b.variables.id);
      if (!pr) return this.json(200, { errors: [{ message: "not found" }] });
      pr.draft = false;
      return this.json(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
    }
    if (path === "/repos/o/r" && req.method === "GET") return this.json(200, { id: 42, default_branch: "main" });
    const ref = /^\/repos\/o\/r\/git\/ref\/heads\/(.+)$/.exec(path);
    if (ref && req.method === "GET") { const sha = this.refs.get(decodeURIComponent(ref[1] as string)); return sha ? this.json(200, { object: { sha } }) : this.json(404, { message: "Not Found" }); }
    if (path === "/repos/o/r/git/refs" && req.method === "POST") {
      if (!can("contents", "write")) return this.json(403, { message: "Resource not accessible by integration" });
      const b = (await req.json()) as { ref: string; sha: string };
      const name = b.ref.replace(/^refs\/heads\//, "");
      if (this.refs.has(name)) return this.json(422, { message: "Reference already exists" });
      this.refs.set(name, b.sha);
      return this.json(201, { object: { sha: b.sha } });
    }
    if (path === "/repos/o/r/pulls" && req.method === "GET") {
      const head = (u.searchParams.get("head") ?? "").split(":")[1];
      return this.json(200, this.prs.filter((p) => !head || p.head.ref === head));
    }
    if (path === "/repos/o/r/pulls" && req.method === "POST") {
      if (!can("pull_requests", "write")) return this.json(403, { message: "Resource not accessible by integration" });
      this.onBeforeCreatePr?.();
      const b = (await req.json()) as { head: string; base: string; draft: boolean };
      if (this.prs.some((p) => p.head.ref === b.head && p.state === "open")) return this.json(422, { message: "A pull request already exists" });
      const sha = this.refs.get(b.head);
      if (!sha) return this.json(422, { message: "head invalid" });
      return this.json(201, this.addPr(b.head, sha, b.draft));
    }
    const mg = /^\/repos\/o\/r\/pulls\/(\d+)\/merge$/.exec(path);
    if (mg && req.method === "PUT") {
      this.mergeCalls++;
      if (!(can("contents", "write") && can("pull_requests", "write"))) return this.json(403, { message: "Resource not accessible by integration" });
      const pr = this.prs.find((x) => x.number === Number(mg[1]));
      const b = (await req.json()) as { sha: string };
      if (!pr) return this.json(404, { message: "Not Found" });
      if (this.mergeFault === "error-before-merge") return this.json(502, { message: "Bad Gateway" });
      if (pr.state !== "open" || pr.merged) return this.json(405, { message: "Pull Request is not mergeable" });
      if (pr.draft) return this.json(405, { message: "Draft pull requests cannot be merged" });
      if (this.protectBase) return this.json(405, { message: "Required status checks are expected" });
      if (b.sha !== pr.head.sha) return this.json(409, { message: "Head branch was modified. Review and try the merge again." });
      const sha = (++this.mergeN).toString(16).padStart(8, "0").repeat(5);
      pr.merged = true; pr.state = "closed"; pr.merge_commit_sha = sha; this.refs.set(pr.base.ref, sha);
      if (this.mergeFault === "timeout-after-merge") return this.json(504, { message: "Gateway Timeout" });
      return this.json(200, { merged: true, sha });
    }
    const cr = /^\/repos\/o\/r\/commits\/([a-f0-9]{40})\/check-runs$/.exec(path);
    if (cr && req.method === "GET") return this.json(200, { check_runs: (this.checks.get(cr[1] as string) ?? []).map((c) => ({ ...c, head_sha: cr[1] })) });
    const prn = /^\/repos\/o\/r\/pulls\/(\d+)$/.exec(path);
    if (prn && req.method === "GET") { const p = this.prs.find((x) => x.number === Number(prn[1])); return p ? this.json(200, p) : this.json(404, { message: "Not Found" }); }
    return this.json(404, { message: "Not Found" });
  }
}
