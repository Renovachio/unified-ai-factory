import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCloudInvariants, CloudConfigInvalid, CloudDenied, CloudSandboxController, decidePlacement, EgressPolicy, generateAttestationKeypair, loadCloudConfig, QuotaLedger,
  SimulatedCloudProvider, signAttestation, verifyAttestation, detectBackend, type Attestation, type CloudConfig, type SandboxSpec,
} from "../src/index";

const DIGEST = "sha256:" + "a".repeat(64);
const keys = generateAttestationKeypair();
const shipped = loadCloudConfig(join(import.meta.dir, "../../../config"));
const enabledCfg = (over: Partial<CloudConfig> = {}): CloudConfig => ({
  ...shipped, enabled: true, operatorEnablement: { enabledBy: "test operator", enabledOn: "2026-11-19", hostInfrastructureLimitAcknowledged: true },
  images: { allowedDigests: [DIGEST] }, attestation: { maxAgeSeconds: 300, providerPublicKeyPem: keys.publicKeyPem },
  limits: { ...shipped.limits, maxConcurrentSandboxes: 2, maxSandboxSecondsPerDay: 100, maxWallSecondsPerSandbox: 60, sandboxTtlSeconds: 120 },
  egress: { ...shipped.egress, allowedHosts: ["huggingface.co", "models.example.org", "rebind.example.org"] }, ...over,
});
const resolver = async (h: string) => ({ "huggingface.co": ["151.101.1.1"], "models.example.org": ["93.184.216.34"], "rebind.example.org": ["127.0.0.1"] } as Record<string, string[]>)[h] ?? [];
const res = { wallSeconds: 10, memoryMb: 512, cpuCores: 1, diskMb: 256 };

describe("configuration: cloud is off unless an operator explicitly enables it", () => {
  test("the shipped config is disabled and valid", () => {
    expect(shipped.enabled).toBe(false);
    expect(shipped.operatorEnablement).toBeNull();
  });
  test("enabling requires who/when/limit-acknowledgement, pinned images, an attestation key and a hardened egress config", () => {
    const base = enabledCfg();
    expect(() => assertCloudInvariants(base)).not.toThrow();
    const cases: Array<[string, Partial<CloudConfig>]> = [
      ["no operatorEnablement", { operatorEnablement: null }],
      ["no pinned images", { images: { allowedDigests: [] } }],
      ["no attestation key", { attestation: { maxAgeSeconds: 300, providerPublicKeyPem: null } }],
      ["wildcard egress host", { egress: { ...base.egress, allowedHosts: ["*.example.org"] } }],
      ["metadata range removed from deny list", { egress: { ...base.egress, deniedCidrs: ["127.0.0.0/8", "10.0.0.0/8"] } }],
    ];
    for (const [name, over] of cases) expect(() => assertCloudInvariants({ ...base, ...over }), name).toThrow(CloudConfigInvalid);
  });
});

describe("attestation", () => {
  const nonce = "n".repeat(32);
  const good = (over: Partial<Attestation> = {}): Attestation => ({ provider: "p", sandboxId: "sbx_1", imageDigest: DIGEST, region: "r", nonce, issuedAtMs: Date.now(), claims: { rootless: true, hostMounts: [], networkMode: "egress-proxy" }, ...over });
  const expectation = { publicKeyPem: keys.publicKeyPem, allowedImageDigests: [DIGEST], nonce, sandboxId: "sbx_1", maxAgeSeconds: 300 };
  test("a fresh, signed, allowlisted, rootless, mount-free attestation verifies", () => {
    expect(verifyAttestation(signAttestation(good(), keys.privateKeyPem), expectation)).toEqual({ ok: true, reasons: [] });
  });
  test.each([
    ["missing", null, ["no-attestation"]],
    ["wrong signing key", signAttestation(good(), generateAttestationKeypair().privateKeyPem), ["signature-invalid"]],
    ["unknown image", signAttestation(good({ imageDigest: "sha256:" + "b".repeat(64) }), keys.privateKeyPem), ["image-not-allowlisted"]],
    ["replayed nonce", signAttestation(good({ nonce: "x".repeat(32) }), keys.privateKeyPem), ["nonce-mismatch"]],
    ["another sandbox", signAttestation(good({ sandboxId: "sbx_2" }), keys.privateKeyPem), ["sandbox-mismatch"]],
    ["stale", signAttestation(good({ issuedAtMs: Date.now() - 3_600_000 }), keys.privateKeyPem), ["attestation-stale"]],
    ["not rootless", signAttestation(good({ claims: { rootless: false, hostMounts: [], networkMode: "egress-proxy" } }), keys.privateKeyPem), ["not-rootless"]],
    ["host mounts", signAttestation(good({ claims: { rootless: true, hostMounts: ["/var/run/docker.sock"], networkMode: "egress-proxy" } }), keys.privateKeyPem), ["host-mounts-present"]],
    ["open network", signAttestation(good({ claims: { rootless: true, hostMounts: [], networkMode: "open" } }), keys.privateKeyPem), ["open-network"]],
  ] as const)("%s is rejected", (_n, att, reasons) => {
    const r = verifyAttestation(att as never, expectation);
    expect(r.ok).toBe(false);
    for (const x of reasons) expect(r.reasons).toContain(x);
  });
  test("tampering with a signed attestation invalidates it", () => {
    const s = signAttestation(good(), keys.privateKeyPem);
    s.attestation.claims.hostMounts = ["/"];
    expect(verifyAttestation(s, expectation).reasons).toContain("signature-invalid");
  });
});

describe("egress policy / SSRF", () => {
  const p = new EgressPolicy(enabledCfg().egress, resolver);
  const denied: Array<[string, RegExp]> = [
    ["https://169.254.169.254/latest/meta-data/", /denied range|not allowlisted/], ["https://metadata.google.internal/computeMetadata/v1/", /denied/], ["https://instance-data/", /denied/],
    ["https://127.0.0.1/", /denied range/], ["https://localhost/", /not allowlisted/], ["https://10.0.0.5/", /denied range/], ["https://172.16.5.5/", /denied range/], ["https://192.168.1.1/", /denied range/],
    ["https://100.64.0.1/", /denied range/], ["https://[::1]/", /denied range/], ["https://[fc00::1]/", /denied range/], ["https://[fe80::1]/", /denied range/],
    ["https://[::ffff:127.0.0.1]/", /denied range/], ["https://[::ffff:7f00:1]/", /denied range/], ["https://[::ffff:169.254.169.254]/", /denied range/],
    ["https://2130706433/", /denied range|numeric host/], ["https://0x7f000001/", /denied range|numeric host/], ["https://huggingface.co@169.254.169.254/", /denied range|credentials/],
    ["http://huggingface.co/", /https only/], ["file:///etc/passwd", /https only/], ["ftp://huggingface.co/", /https only/], ["https://evil.example.com/", /not allowlisted/], ["not a url", /unparseable/],
    ["https://user:pw@huggingface.co/", /credentials in URL/], ["https://rebind.example.org/", /resolves to a forbidden address/],
  ];
  test.each(denied)("denies %s", async (url, why) => { const d = await p.check(url); expect(d.allowed).toBe(false); expect(d.reason).toMatch(why); });
  test("allows only allowlisted https hosts that resolve to public addresses", async () => {
    expect((await p.check("https://huggingface.co/models/x")).allowed).toBe(true);
    expect((await p.check("https://models.example.org/")).allowed).toBe(true);
    expect(p.checkIp("8.8.8.8").allowed).toBe(true);
    expect(p.checkIp("2606:4700::1111").allowed).toBe(true);
    expect(p.checkIp("169.254.169.254").allowed).toBe(false);
  });
});

describe("infrastructure quota", () => {
  test("concurrency, per-sandbox resources, daily seconds; release refunds; leaked reservations expire", () => {
    let t = 1_000_000;
    const q = new QuotaLedger(enabledCfg().limits, () => t);
    const a = q.reserve(res); const b = q.reserve(res);
    expect(a.ok && b.ok).toBe(true);
    expect(q.reserve(res)).toEqual({ ok: false, reason: "concurrency" });
    if (a.ok) q.release(a.reservationId, 2);
    expect(q.activeCount).toBe(1);
    expect(q.reserve({ ...res, wallSeconds: 61 })).toEqual({ ok: false, reason: "wall-time" });
    expect(q.reserve({ ...res, memoryMb: 999_999 })).toEqual({ ok: false, reason: "memory" });
    expect(q.reserve({ ...res, cpuCores: 64 })).toEqual({ ok: false, reason: "cpu" });
    expect(q.reserve({ ...res, diskMb: 999_999 })).toEqual({ ok: false, reason: "disk" });
    const c = q.reserve({ ...res, wallSeconds: 60 });
    expect(c.ok).toBe(true); // daily total now 10 (b) + 2 (a refunded) + 60 = 72
    expect(q.reserve({ ...res, wallSeconds: 40 }).ok).toBe(false); // concurrency anyway
    t += 121_000; // reservations older than the TTL are reclaimed (leak protection)
    expect(q.activeCount).toBe(0);
    const d = q.reserve({ ...res, wallSeconds: 60 });
    expect(d).toEqual({ ok: false, reason: "daily-seconds" }); // 72 + 60 > 100
    t += 86_400_000;
    expect(q.reserve({ ...res, wallSeconds: 60 }).ok).toBe(true); // new day
  });
});

describe("placement", () => {
  const base = { cloudEnabled: false, repoAllowedRemote: false, adapterAuthMode: "local_model" as const, localHasCapacity: true, localIsolationStrong: true, cloudQuotaAvailable: true };
  test("local by default; cloud only when enabled, the repo is approved, the adapter is a self-hosted model and quota exists; subscription CLIs never go remote; otherwise BLOCK/queue", () => {
    expect(decidePlacement(base).placement).toBe("LOCAL");
    expect(decidePlacement({ ...base, localHasCapacity: false })).toMatchObject({ placement: "BLOCK" });
    expect(decidePlacement({ ...base, localHasCapacity: false, cloudEnabled: true, repoAllowedRemote: true }).placement).toBe("CLOUD");
    expect(decidePlacement({ ...base, localHasCapacity: false, cloudEnabled: true, repoAllowedRemote: false }).placement).toBe("BLOCK");
    expect(decidePlacement({ ...base, localHasCapacity: false, cloudEnabled: true, repoAllowedRemote: true, cloudQuotaAvailable: false }).placement).toBe("BLOCK");
    const sub = decidePlacement({ ...base, adapterAuthMode: "subscription_cli", localHasCapacity: false, cloudEnabled: true, repoAllowedRemote: true });
    expect(sub.placement).toBe("BLOCK");
    expect(sub.reasons.join(" ")).toMatch(/subscription CLI credentials may not leave/);
    expect(decidePlacement({ ...base, cloudEnabled: true, repoAllowedRemote: true, explicitRemoteRequest: true }).placement).toBe("CLOUD");
    expect(decidePlacement({ ...base, adapterAuthMode: "subscription_cli", cloudEnabled: true, repoAllowedRemote: true, explicitRemoteRequest: true }).placement).toBe("LOCAL");
    expect(decidePlacement({ ...base, localIsolationStrong: false }).placement).toBe("BLOCK"); // weak local isolation + untrusted repo
    expect(decidePlacement({ ...base, localIsolationStrong: false, repoTrusted: true }).placement).toBe("LOCAL");
    expect(decidePlacement({ ...base, localIsolationStrong: false, cloudEnabled: true, repoAllowedRemote: true }).placement).toBe("CLOUD");
  });
});

describe("cloud sandbox lifecycle, isolation parity and teardown (simulated provider)", () => {
  const make = (over: Partial<CloudConfig> = {}, now?: () => number) => {
    const cfg = enabledCfg(over);
    const provider = new SimulatedCloudProvider(keys.privateKeyPem, new EgressPolicy(cfg.egress, resolver), detectBackend(), now);
    const quota = new QuotaLedger(cfg.limits, now);
    return { cfg, provider, quota, ctl: new CloudSandboxController(cfg, provider, quota, now) };
  };
  const run = (c: ReturnType<typeof make>, script: string, extra: Record<string, unknown> = {}) => c.ctl.run({ jobId: "job1", imageDigest: DIGEST, resources: res, command: "/bin/sh", args: ["-c", script], timeoutMs: 8000, ...extra });

  test("disabled by default: nothing is created", async () => {
    const provider = new SimulatedCloudProvider(keys.privateKeyPem, new EgressPolicy(shipped.egress));
    const ctl = new CloudSandboxController(shipped, provider, new QuotaLedger(shipped.limits));
    await expect(ctl.run({ jobId: "j", imageDigest: DIGEST, resources: res, command: "/bin/true", args: [], timeoutMs: 1000 })).rejects.toMatchObject({ code: "disabled" });
    expect(await provider.list({})).toEqual([]);
    provider.dispose();
  });

  test("a successful run executes inside the sandbox, then the sandbox is destroyed, verified gone (provider list + disk) and the quota released", async () => {
    const c = make();
    const r = await run(c, "echo hello > out.txt && cat out.txt");
    expect(r.run).toMatchObject({ exitCode: 0 });
    expect(r.run.stdout.trim()).toBe("hello");
    expect(r.teardownVerified).toBe(true);
    expect(await c.provider.list({ jobId: "job1" })).toEqual([]);
    expect(c.provider.residue(r.sandboxId)).toBe(false);
    expect(c.provider.dirs()).toEqual([]);
    expect(c.quota.activeCount).toBe(0);
    c.provider.dispose();
  });

  test("teardown also happens on failure, timeout and cancellation", async () => {
    const c = make();
    const fail = await run(c, "exit 3");
    expect(fail.run.exitCode).toBe(3);
    const t0 = Date.now();
    const slow = await run(c, "sleep 30 & wait", { timeoutMs: 400 });
    expect(slow.run.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await expect(run(c, "sleep 30", { signal: ac.signal, timeoutMs: 30_000 })).rejects.toBeInstanceOf(CloudDenied);
    await new Promise((r) => setTimeout(r, 1500)); // killing the group completes asynchronously
    expect(await c.provider.list({})).toEqual([]);
    expect(c.quota.activeCount).toBe(0);
    c.provider.dispose();
  });

  test("a sandbox whose attestation is bad never executes anything and is destroyed", async () => {
    const mis: Array<[string, SimulatedCloudProvider["misbehave"], RegExp]> = [
      ["forged signature", { badSignature: true }, /signature-invalid/], ["stale", { staleMs: 3_600_000 }, /attestation-stale/], ["host mounts", { hostMounts: ["/var/run/docker.sock"] }, /host-mounts-present/],
      ["open network", { openNetwork: true }, /open-network/], ["wrong image", { imageDigest: "sha256:" + "c".repeat(64) }, /image-not-allowlisted/],
    ];
    for (const [name, m, why] of mis) {
      const c = make();
      c.provider.misbehave = m;
      const marker = join(mkdtempSync(join(tmpdir(), "mk-")), "RAN");
      await expect(run(c, `touch ${marker}`), name).rejects.toThrow(why);
      expect(existsSync(marker), name).toBe(false);
      expect(await c.provider.list({}), name).toEqual([]);
      expect(c.quota.activeCount, name).toBe(0);
      c.provider.dispose();
    }
  });

  test("quota: the 3rd concurrent sandbox is refused (infrastructure limit), without creating anything", async () => {
    const c = make();
    const held = [c.quota.reserve(res), c.quota.reserve(res)];
    expect(held.every((h) => h.ok)).toBe(true);
    await expect(run(c, "true")).rejects.toMatchObject({ code: "quota", detail: { reason: "concurrency" } });
    expect(await c.provider.list({})).toEqual([]);
    await expect(c.ctl.run({ jobId: "j", imageDigest: DIGEST, resources: { ...res, memoryMb: 1_000_000 }, command: "/bin/true", args: [], timeoutMs: 1000 })).rejects.toMatchObject({ code: "quota" });
    c.provider.dispose();
  });

  test("credential transfer is refused BEFORE any sandbox exists; image must be allowlisted", async () => {
    const c = make();
    for (const env of [{ ANTHROPIC_API_KEY: "x" }, { OPENAI_API_KEY: "x" }, { GITHUB_TOKEN: "x" }, { SSH_AUTH_SOCK: "/tmp/a" }, { CLAUDE_CODE_OAUTH_TOKEN: "x" }, { AWS_SECRET_ACCESS_KEY: "x" }]) {
      await expect(run(c, "true", { env }), JSON.stringify(env)).rejects.toMatchObject({ code: "credentials" });
    }
    expect(await c.provider.list({})).toEqual([]);
    await expect(c.ctl.run({ jobId: "j", imageDigest: "sha256:" + "d".repeat(64), resources: res, command: "/bin/true", args: [], timeoutMs: 1000 })).rejects.toMatchObject({ code: "attestation" });
    c.provider.dispose();
  });

  test("PARITY: the same adversarial checks as the local sandbox — host files, writes outside, network, env secrets, traversal", async () => {
    const c = make();
    const hostDir = mkdtempSync(join(tmpdir(), "cloud-host-"));
    writeFileSync(join(hostDir, "s.txt"), "HOST-SECRET");
    let hits = 0;
    const srv = createServer((s) => { hits++; s.end("pwned"); });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    process.env.ANTHROPIC_API_KEY = "sk-ant-CLOUD-LEAK-1234567890";
    try {
      const out = await run(c, [`cat ${join(hostDir, "s.txt")} 2>/dev/null`, `echo x > ${join(hostDir, "w.txt")} 2>/dev/null`, `curl -s -m 2 http://127.0.0.1:${port}/ 2>/dev/null`, `curl -s -m 2 http://169.254.169.254/ 2>/dev/null`, "env", `cat ../../../../etc/hosts 2>/dev/null | head -c 3`].join("; "));
      expect(out.run.stdout).not.toContain("HOST-SECRET");
      expect(out.run.stdout).not.toContain("pwned");
      expect(out.run.stdout).not.toMatch(/ANTHROPIC|CLOUD-LEAK/);
      expect(existsSync(join(hostDir, "w.txt"))).toBe(false);
      expect(hits).toBe(0);
    } finally { delete process.env.ANTHROPIC_API_KEY; srv.close(); }
    c.provider.dispose();
  });

  test("a sandbox cannot reach metadata, loopback/host services or the secret broker through the egress proxy", async () => {
    const c = make();
    const h = await c.provider.create({ jobId: "j", imageDigest: DIGEST, nonce: "n", resources: res, labels: {} } as SandboxSpec);
    for (const u of ["https://169.254.169.254/latest/meta-data/iam", "https://127.0.0.1:8200/v1/secret", "https://10.1.2.3/broker", "https://localhost/secrets", "https://broker.internal/token", "https://[::1]/"]) expect(await c.provider.fetchFromSandbox(h, u), u).toMatchObject({ blocked: expect.any(String) });
    expect(await c.provider.fetchFromSandbox(h, "https://huggingface.co/model.bin")).toEqual({ status: 200 });
    await c.provider.destroy(h.id);
    c.provider.dispose();
  });

  test("destroy failures surface; leaked sandboxes are swept after the TTL; destroy is idempotent", async () => {
    let t = 5_000_000;
    const c = make({}, () => t);
    c.provider.misbehave = { destroyFails: true };
    await expect(run(c, "true")).rejects.toThrow(/destroy failed/);
    expect((await c.provider.list({})).length).toBe(1); // leaked
    expect(c.quota.activeCount).toBe(0); // quota is still released
    expect(await c.ctl.sweepOrphans()).toEqual([]); // not old enough yet
    c.provider.misbehave = {};
    t += 121_000;
    const removed = await c.ctl.sweepOrphans();
    expect(removed.length).toBe(1);
    expect(await c.provider.list({})).toEqual([]);
    await c.provider.destroy(removed[0] as string); // idempotent
    c.provider.dispose();
  });
});
