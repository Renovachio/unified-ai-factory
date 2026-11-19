import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

export interface Attestation {
  provider: string;
  sandboxId: string;
  imageDigest: string;
  region: string;
  /** Fresh per-sandbox value chosen by the controller; binds the attestation to THIS request (replay protection). */
  nonce: string;
  issuedAtMs: number;
  /** What the sandbox claims about itself: no host mounts, no credentials, no docker socket. */
  claims: { rootless: boolean; hostMounts: string[]; networkMode: "egress-proxy" | "none" | "open" };
}
export interface SignedAttestation { attestation: Attestation; signature: string }

const canon = (a: Attestation) => JSON.stringify({ provider: a.provider, sandboxId: a.sandboxId, imageDigest: a.imageDigest, region: a.region, nonce: a.nonce, issuedAtMs: a.issuedAtMs, claims: { rootless: a.claims.rootless, hostMounts: a.claims.hostMounts, networkMode: a.claims.networkMode } });

export const generateAttestationKeypair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
};
export const signAttestation = (a: Attestation, privateKeyPem: string): SignedAttestation => ({ attestation: a, signature: sign(null, Buffer.from(canon(a)), createPrivateKey(privateKeyPem)).toString("base64") });

export function verifyAttestation(s: SignedAttestation | null | undefined, e: { publicKeyPem: string; allowedImageDigests: readonly string[]; nonce: string; sandboxId: string; maxAgeSeconds: number; nowMs?: number }): { ok: boolean; reasons: string[] } {
  if (!s) return { ok: false, reasons: ["no-attestation"] };
  const reasons: string[] = [];
  try { if (!verify(null, Buffer.from(canon(s.attestation)), createPublicKey(e.publicKeyPem), Buffer.from(s.signature, "base64"))) reasons.push("signature-invalid"); } catch { reasons.push("signature-invalid"); }
  const a = s.attestation;
  if (!e.allowedImageDigests.includes(a.imageDigest)) reasons.push("image-not-allowlisted");
  if (a.nonce !== e.nonce) reasons.push("nonce-mismatch");
  if (a.sandboxId !== e.sandboxId) reasons.push("sandbox-mismatch");
  if ((e.nowMs ?? Date.now()) - a.issuedAtMs > e.maxAgeSeconds * 1000 || a.issuedAtMs > (e.nowMs ?? Date.now()) + 30_000) reasons.push("attestation-stale");
  if (!a.claims.rootless) reasons.push("not-rootless");
  if (a.claims.hostMounts.length > 0) reasons.push("host-mounts-present");
  if (a.claims.networkMode === "open") reasons.push("open-network");
  return { ok: reasons.length === 0, reasons };
}
