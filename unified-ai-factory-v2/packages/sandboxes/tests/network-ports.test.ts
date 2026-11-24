import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxEnv, BwrapBackend, createWorkspace, detectBackend, PolicyViolation, runSandboxed, seatbeltProfile, teardownWorkspace } from "../src/index";

const seatbelt = process.platform === "darwin" && detectBackend().name === "seatbelt";
const t = seatbelt ? test : test.skip;
let base = ""; type L = Bun.TCPSocketListener<undefined>; let allowed: L; let other: L;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "np-"));
  const mk = (): L => Bun.listen<undefined>({ hostname: "127.0.0.1", port: 0, socket: { open(s) { s.write("hello"); s.end(); }, data() {} } });
  allowed = mk(); other = mk();
});
afterAll(() => { allowed.stop(true); other.stop(true); rmSync(base, { recursive: true, force: true }); });

async function connect(port: number, ports?: number[]) {
  const ws = createWorkspace(base, "np1");
  try {
    const script = `const s = await Bun.connect({ hostname: "127.0.0.1", port: ${port}, socket: { data(_, d) { console.log("GOT:" + Buffer.from(d)); }, error() {}, close() {} } }).catch(() => null); if (!s) console.log("DENIED"); await Bun.sleep(300); process.exit(0);`;
    const r = await runSandboxed({ backend: detectBackend(), workspaceRoot: ws.root, cwd: ws.repoDir, command: process.execPath, args: ["-e", script], env: buildSandboxEnv({ home: ws.homeDir, tmp: ws.tmpDir }), timeoutMs: 15_000, readOnlyPaths: [process.execPath.replace(/\/[^/]+$/, "")], ...(ports ? { allowNetworkPorts: ports } : {}) });
    return r.stdout + r.stderr;
  } finally { teardownWorkspace(base, ws); }
}

describe("ADR-0004: per-port outbound network in the Seatbelt profile", () => {
  t("default: no network at all (loopback included)", async () => { expect(await connect(allowed.port)).not.toContain("GOT:hello"); });
  t("a listed port is reachable and an unlisted port stays blocked", async () => {
    expect(await connect(allowed.port, [allowed.port])).toContain("GOT:hello");
    expect(await connect(other.port, [allowed.port])).not.toContain("GOT:hello");
  });
  test("profile text: no inbound, deny-by-default stays, ports validated", () => {
    const p = seatbeltProfile({ workspaceRoot: base, allowNetworkPorts: [443] });
    expect(p).toContain("(deny default)"); expect(p).toContain('(remote tcp "*:443")'); expect(p).not.toContain("network-inbound"); expect(p).not.toContain("network*)\n(allow network*");
    expect(seatbeltProfile({ workspaceRoot: base })).toContain("(deny network*)");
    expect(() => seatbeltProfile({ workspaceRoot: base, allowNetworkPorts: [0] })).toThrow(PolicyViolation);
    expect(() => seatbeltProfile({ workspaceRoot: base, allowNetworkPorts: [70000] })).toThrow(PolicyViolation);
  });
  test("bwrap refuses per-port network instead of widening", () => {
    const b = new BwrapBackend("/usr/bin/bwrap");
    expect(() => b.wrap("/bin/true", [], { workspaceRoot: base, allowNetworkPorts: [443] })).toThrow(/only implemented for the macOS/);
  });
});
