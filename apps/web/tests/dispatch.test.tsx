import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { routeCommand } from "../lib/command-route";
import { ActiveJobsTable, ApprovalsInbox, CommandBox, HealthPanel, JobControls, ModelReadiness, ProjectsTable, type ApprovalItem, type ModelsView, type SummaryView } from "../lib/dispatch-view";

const html = (n: React.ReactElement) => renderToStaticMarkup(n);
const noop = async () => undefined;
const sum = (o: Partial<SummaryView> = {}): SummaryView => ({ jobs: { inFlight: 0, waitingOnHuman: 0, total: 0 }, approvals: { pending: 0, jobDecisions: 0, capabilityApprovals: 0 }, projects: 0, workers: { active: 0 }, ...o });
const models = (o: Partial<ModelsView> = {}): ModelsView => ({ configLoaded: true, policy: { allowedInferenceModes: ["subscription_cli", "local_model"], modelApiBillingEnabled: false }, available: [], qualified: [], authorizedProviders: [], summary: { available: 0, qualified: 0, authorized: 0 }, ...o });

describe("home: health, projects, jobs, approvals (DSP-07)", () => {
  test("health speaks plainly: quiet, needs-you, and queued-without-workers are different sentences", () => {
    expect(html(<HealthPanel s={sum()} />)).toContain("All quiet");
    expect(html(<HealthPanel s={sum({ approvals: { pending: 2, jobDecisions: 1, capabilityApprovals: 1 } })} />)).toContain("2 item(s) need your decision");
    expect(html(<HealthPanel s={sum({ jobs: { inFlight: 3, waitingOnHuman: 0, total: 3 } })} />)).toContain("no worker is running them");
    expect(html(<HealthPanel s={sum()} />)).toContain('role="status"');
  });
  test("empty states explain what to do; tables have captions and scoped headers", () => {
    expect(html(<ProjectsTable items={[]} />)).toContain("/new &lt;folder&gt;");
    expect(html(<ActiveJobsTable items={[]} />)).toContain("No jobs");
    const t = html(<ProjectsTable items={[{ id: "p1", name: "acme/clip", provider: "github", jobs: { total: 3, active: 1, waitingOnHuman: 1 } }]} />);
    expect(t).toContain("<caption"); expect(t).toContain('scope="col"'); expect(t).toContain('href="/projects/p1"');
  });
  test("untrusted job titles are escaped and labelled", () => {
    const evil = `<script>steal()</script><img src=x onerror=alert(1)>`;
    const out = html(<ActiveJobsTable items={[{ id: "11111111-1111-4111-8111-111111111111", projectId: "p", project: "o/r", state: "BUILDING", revision: 2, risk: "LOW", prNumber: null, title: { text: evil, trust: "untrusted" }, paused: true, updatedAt: "2026-11-19T10:00:00Z" }]} />);
    expect(out).not.toContain("<script>"); expect(out).not.toContain("<img"); expect(out).toContain("untrusted"); expect(out).toContain("paused");
  });
});

describe("approvals inbox", () => {
  const items: ApprovalItem[] = [{ id: "a1", type: "capability-approval", operation: "activate", capability: "skill:pdf-summary@1.0.0", digest: "sha256:" + "a".repeat(64), permissionDigest: "sha256:" + "b".repeat(64), expiresAt: "2026-12-01T00:00:00Z" }, { id: "j1", type: "job-decision", project: "o/r", revision: 4, title: { text: "x" }, at: "2026-11-19T00:00:00Z" }];
  test("a capability approval shows the exact digests, carries them in the form, says activation is separate, and labels its buttons precisely", () => {
    const out = html(<ApprovalsInbox items={items} decide={noop} />);
    expect(out).toContain("a".repeat(64)); expect(out).toContain('name="digest"'); expect(out).toContain('name="permissionDigest"'); expect(out).toContain("Approve these exact digests"); expect(out).toContain("Activation is a separate step");
  });
  test("job decisions are routed to the exact-SHA review page, not decided inline", () => { const out = html(<ApprovalsInbox items={[items[1] as ApprovalItem]} decide={noop} />); expect(out).toContain("/inbox"); expect(out).not.toContain("<form"); });
  test("empty inbox says so", () => expect(html(<ApprovalsInbox items={[]} decide={noop} />)).toContain("Nothing needs your attention"));
});

describe("model readiness keeps available, qualified and authorized separate", () => {
  test("nothing configured -> says no model work can run; not a green light", () => {
    const out = html(<ModelReadiness m={models()} />); expect(out).toContain("No model runtime is configured"); expect(out).toContain("Available"); expect(out).toContain("Qualified"); expect(out).toContain("Authorized"); expect(out).toContain("disabled");
  });
  test("available but unqualified is distinguishable from qualified but unauthorized", () => {
    expect(html(<ModelReadiness m={models({ summary: { available: 1, qualified: 0, authorized: 0 }, available: [{ id: "claude-cli", path: "/x" }] })} />)).toContain("no model is qualified");
    expect(html(<ModelReadiness m={models({ summary: { available: 1, qualified: 1, authorized: 0 }, available: [{ id: "r", path: "/x" }], qualified: [{ role: "builder", model: "m", runtime: "r", expiresAt: null }] })} />)).toContain("no provider authorization");
  });
  test("unreadable configuration is announced, never shown as ready", () => expect(html(<ModelReadiness m={models({ configLoaded: false })} />)).toContain('role="alert"'));
});

describe("controls and command box are accessible and safe", () => {
  test("cancel needs the typed id prefix and states the revision it applies to; finished jobs offer no controls", () => {
    const out = html(<JobControls jobId="abcdef12-0000-4000-8000-000000000000" state="BUILDING" paused={false} revision={7} act={noop} />);
    expect(out).toContain("abcdef12"); expect(out).toContain("required"); expect(out).toContain("revision 7"); expect(out).toContain("Pause at a safe point");
    expect(html(<JobControls jobId="abcdef12-0000-4000-8000-000000000000" state="BUILDING" paused={true} revision={7} act={noop} />)).toContain("Resume");
    expect(html(<JobControls jobId="x" state="DONE" paused={false} revision={1} act={noop} />)).toContain("nothing to control");
  });
  test("every input has a label; the command box is a landmark with a described hint", () => {
    const out = html(<CommandBox action={noop} notice="hello" />); expect(out).toContain('for="cmd"'); expect(out).toContain('id="cmd"'); expect(out).toContain('role="search"'); expect(out).toContain('aria-describedby="cmd-help"'); expect(out).toContain('role="status"');
    const a = html(<ApprovalsInbox items={[{ id: "a", type: "capability-approval", operation: "activate", capability: "c", digest: "d", permissionDigest: "p", expiresAt: "2026-12-01T00:00:00Z" }]} decide={noop} />); expect(a).toContain("<label>Note");
  });
});

describe("command box only navigates", () => {
  test("slash commands and deterministic phrases route to pages", () => {
    expect(routeCommand("/jobs")).toEqual({ to: "/jobs" }); expect(routeCommand("/models")).toEqual({ to: "/models" }); expect(routeCommand("/approvals")).toEqual({ to: "/approvals" }); expect(routeCommand("show my jobs")).toEqual({ to: "/jobs" });
    expect(routeCommand("list skills")).toEqual({ to: "/skills" }); expect(routeCommand("/status")).toEqual({ to: "/" }); expect(routeCommand("/logs abc12345")).toEqual({ to: "/logs?job=abc12345" }); expect(routeCommand("/project use p-1")).toEqual({ to: "/projects/p-1" });
  });
  test("mutating, destructive, unknown and unrecognised input never execute and never navigate to an attacker-chosen URL", () => {
    for (const t of ["/cancel j1", "/pause j1", "/resume j1", "/approve a1", "/new Thing", "/dispatch add dark mode", "/new ~/x"]) expect(routeCommand(t)).toHaveProperty("notice");
    expect(routeCommand("/cancel j1")).toMatchObject({ notice: expect.stringContaining("not run from this box") });
    for (const t of ["/rm -rf /", "https://evil.example", "//evil.example", "javascript:alert(1)", "pause the clipboard job", "stop everything", "/exit", "/shutdown", ""]) expect(routeCommand(t)).toHaveProperty("notice");
    const r = routeCommand("/project use ../../evil"); expect(r).toHaveProperty("notice");
    for (const t of ["/logs a/b", "/projects"]) { const x = routeCommand(t); if ("to" in x) expect(x.to.startsWith("/")).toBe(true); }
  });
});
