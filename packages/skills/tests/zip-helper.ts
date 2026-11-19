import { deflateRawSync } from "node:zlib";

export interface ZipSpec { name: string; data?: Buffer | string; mode?: number; deflate?: boolean; declaredUsize?: number; dir?: boolean; encrypted?: boolean }
/** Test-only ZIP writer (can emit hostile archives that real tools refuse to create). */
export function makeZip(specs: ZipSpec[]): Buffer {
  const locals: Buffer[] = []; const central: Buffer[] = []; let off = 0;
  for (const s of specs) {
    const raw = Buffer.from(s.data ?? "");
    const method = s.deflate ? 8 : 0; const comp = s.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(s.name);
    const flags = s.encrypted ? 1 : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(s.declaredUsize ?? raw.length, 22); lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x031e, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(s.declaredUsize ?? raw.length, 24); ch.writeUInt16LE(name.length, 28);
    const mode = s.mode ?? (s.dir || s.name.endsWith("/") ? 0o040755 : 0o100644);
    ch.writeUInt32LE(((mode << 16) >>> 0), 38); ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(specs.length, 8); eocd.writeUInt16LE(specs.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
