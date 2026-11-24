import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { resolveInside } from "@factory/sandboxes";

export interface ArchiveLimits { maxFiles: number; maxTotalBytes: number; maxFileBytes: number; maxRatio: number; maxDepth: number; maxPathLen: number }
export const DEFAULT_LIMITS: ArchiveLimits = { maxFiles: 500, maxTotalBytes: 20 * 1024 * 1024, maxFileBytes: 5 * 1024 * 1024, maxRatio: 100, maxDepth: 8, maxPathLen: 200 };
export class ArchiveRejected extends Error { constructor(readonly code: string, message: string) { super(message); this.name = "ArchiveRejected"; } }

interface ZipEntry { name: string; method: number; csize: number; usize: number; offset: number; unixMode: number; isDir: boolean }

/** Path rules applied to every archive member BEFORE anything is written. */
export function checkMemberName(name: string, lim: ArchiveLimits): string {
  if (name.length === 0 || name.length > lim.maxPathLen) throw new ArchiveRejected("path-length", `bad member name length (${name.length})`);
  if (name.includes("\0")) throw new ArchiveRejected("nul-byte", "NUL byte in member name");
  if (name.includes("\\")) throw new ArchiveRejected("backslash", `backslash in member name: ${name.slice(0, 60)}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw new ArchiveRejected("absolute-path", `absolute member path: ${name.slice(0, 60)}`);
  if (name.includes(":")) throw new ArchiveRejected("alternate-data-stream", `':' in member name (NTFS stream / drive): ${name.slice(0, 60)}`);
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) throw new ArchiveRejected("traversal", `traversal or empty segment: ${name.slice(0, 60)}`);
  if (parts.length > lim.maxDepth) throw new ArchiveRejected("too-deep", `path nests ${parts.length} levels`);
  // control characters / bidi overrides make names deceptive in UIs
  if ([...name].some((c) => c.charCodeAt(0) < 32 || /[‪-‮⁦-⁩]/.test(c))) throw new ArchiveRejected("control-char", "control or bidi character in member name");
  return parts.join("/");
}

export function readZipEntries(buf: Uint8Array, lim: ArchiveLimits = DEFAULT_LIMITS): ZipEntry[] {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length > lim.maxTotalBytes) throw new ArchiveRejected("archive-too-large", "archive file exceeds limit");
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ArchiveRejected("not-a-zip", "end of central directory not found");
  const count = b.readUInt16LE(eocd + 10), cdSize = b.readUInt32LE(eocd + 12), cdOff = b.readUInt32LE(eocd + 16);
  if (count > lim.maxFiles) throw new ArchiveRejected("too-many-files", `${count} members (> ${lim.maxFiles})`);
  if (cdOff + cdSize > b.length) throw new ArchiveRejected("corrupt", "central directory out of range");
  const out: ZipEntry[] = []; let p = cdOff; let total = 0;
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) throw new ArchiveRejected("corrupt", "bad central directory entry");
    const flags = b.readUInt16LE(p + 8), method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), usize = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28), elen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), ext = b.readUInt32LE(p + 38), off = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString("utf8");
    if (flags & 1) throw new ArchiveRejected("encrypted", "encrypted members are not accepted");
    if (csize === 0xffffffff || usize === 0xffffffff || off === 0xffffffff) throw new ArchiveRejected("zip64", "zip64 archives are not accepted");
    const clean = checkMemberName(name, lim);
    const isDir = name.endsWith("/");
    const unixMode = (ext >>> 16) & 0xffff; const type = unixMode & 0o170000;
    if (type === 0o120000) throw new ArchiveRejected("symlink", `symlink member: ${name.slice(0, 60)}`);
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw new ArchiveRejected("special-file", `device/fifo/socket member: ${name.slice(0, 60)}`);
    if (method !== 0 && method !== 8) throw new ArchiveRejected("method", `unsupported compression method ${method}`);
    const norm = clean.toLowerCase().normalize("NFC");
    if (seen.has(norm)) throw new ArchiveRejected("duplicate", `duplicate (case/unicode-normalised) member: ${name.slice(0, 60)}`);
    seen.add(norm);
    if (!isDir) {
      if (usize > lim.maxFileBytes) throw new ArchiveRejected("file-too-large", `${name.slice(0, 60)} declares ${usize} bytes`);
      if (csize > 0 && usize / csize > lim.maxRatio) throw new ArchiveRejected("compression-bomb", `${name.slice(0, 60)} ratio ${(usize / csize).toFixed(0)}:1`);
      total += usize;
      if (total > lim.maxTotalBytes) throw new ArchiveRejected("archive-bomb", `declared total exceeds ${lim.maxTotalBytes} bytes`);
    }
    out.push({ name: clean, method, csize, usize, offset: off, unixMode, isDir });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/** Extracts into a fresh quarantine directory with limits enforced on ACTUAL decompressed bytes (declared sizes are not trusted). */
export function extractZip(buf: Uint8Array, dest: string, lim: ArchiveLimits = DEFAULT_LIMITS): { files: string[]; bytes: number } {
  const entries = readZipEntries(buf, lim);
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  const files: string[] = []; let bytes = 0;
  for (const e of entries) {
    const target = resolveInside(dest, e.name);
    if (e.isDir) { mkdirSync(target, { recursive: true, mode: 0o700 }); continue; }
    if (b.readUInt32LE(e.offset) !== 0x04034b50) throw new ArchiveRejected("corrupt", `bad local header for ${e.name.slice(0, 60)}`);
    const start = e.offset + 30 + b.readUInt16LE(e.offset + 26) + b.readUInt16LE(e.offset + 28);
    if (start + e.csize > b.length) throw new ArchiveRejected("corrupt", "member data out of range");
    const raw = b.subarray(start, start + e.csize);
    let data: Buffer;
    try { data = e.method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: lim.maxFileBytes + 1 }); } catch { throw new ArchiveRejected("compression-bomb", `${e.name.slice(0, 60)} inflates beyond the per-file limit or is corrupt`); }
    if (data.length > lim.maxFileBytes || data.length !== e.usize) throw new ArchiveRejected("size-mismatch", `${e.name.slice(0, 60)} actual size ${data.length} differs from declared ${e.usize}`);
    bytes += data.length;
    if (bytes > lim.maxTotalBytes) throw new ArchiveRejected("archive-bomb", "actual extracted bytes exceed limit");
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, data, { mode: (e.unixMode & 0o111) ? 0o700 : 0o600 });
    files.push(e.name);
  }
  return { files, bytes };
}
/** Makes a quarantine tree read-only (files 0400/0500, dirs 0500). */
export function sealReadOnly(root: string, entries: readonly { path: string; executable: boolean }[]): void {
  for (const e of entries) chmodSync(join(root, e.path), e.executable ? 0o500 : 0o400);
}
