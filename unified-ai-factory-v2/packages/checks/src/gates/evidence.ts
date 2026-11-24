import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { canonicalJson } from "@factory/telemetry";

export interface StepResult {
  id: string;
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  startedAt: string;
  logDigest: string;
}

export interface GateEvidence {
  schema: "factory.gate-evidence/1";
  jobId: string;
  repo: string;
  headSha: string;
  baseSha: string;
  manifestProfile: string;
  manifestDigest: string;
  steps: StepResult[];
  verdict: "pass" | "fail" | "error";
  failureClass?: string;
  checkDefiningChanges: string[];
  worktreeMutated: boolean;
  runner: { backend: string; os: string; arch: string; bun: string };
  createdAt: string;
}
export interface SignedEvidence { evidence: GateEvidence; signature: string; keyId: string }

export function generateEvidenceKeypair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

/** Ed25519 signer held by the trusted gate service. Verifiers (merge coordinator) only need the public key. */
export class EvidenceSigner {
  constructor(private readonly privateKeyPem: string, readonly keyId = "gate-evidence-1") {}
  sign(evidence: GateEvidence): SignedEvidence {
    const sig = sign(null, Buffer.from(canonicalJson({ evidence, keyId: this.keyId })), createPrivateKey(this.privateKeyPem));
    return { evidence, signature: sig.toString("base64"), keyId: this.keyId };
  }
}

export interface VerifyExpectation { headSha: string; baseSha: string; manifestDigest: string; jobId?: string }

/** Verifies signature AND that the evidence is about exactly the expected candidate, base and gate manifest. */
export function verifyEvidence(signed: SignedEvidence, publicKeyPem: string, expect: VerifyExpectation): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  try {
    const okSig = verify(null, Buffer.from(canonicalJson({ evidence: signed.evidence, keyId: signed.keyId })), createPublicKey(publicKeyPem), Buffer.from(signed.signature, "base64"));
    if (!okSig) reasons.push("signature-invalid");
  } catch { reasons.push("signature-invalid"); }
  const e = signed.evidence;
  if (e.schema !== "factory.gate-evidence/1") reasons.push("bad-schema");
  if (e.headSha !== expect.headSha) reasons.push("head-sha-mismatch");
  if (e.baseSha !== expect.baseSha) reasons.push("base-sha-mismatch");
  if (e.manifestDigest !== expect.manifestDigest) reasons.push("manifest-digest-mismatch");
  if (expect.jobId && e.jobId !== expect.jobId) reasons.push("job-mismatch");
  if (e.verdict === "pass") {
    if (e.steps.length === 0 || e.steps.some((s) => s.exitCode !== 0 || s.timedOut)) reasons.push("pass-with-failed-step");
    if (e.worktreeMutated) reasons.push("pass-with-mutated-worktree");
    if (e.checkDefiningChanges.length > 0) reasons.push("pass-with-check-defining-changes");
  }
  return { ok: reasons.length === 0, reasons };
}
