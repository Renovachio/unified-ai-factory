import { problems } from "./problem";

/** Reads a JSON body with a hard byte cap (streaming; does not trust Content-Length alone) and strict content type. */
export async function readJson(req: Request, maxBytes: number): Promise<{ raw: string; value: unknown }> {
  const ct = req.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;.*)?$/i.test(ct)) throw problems.unsupportedMedia();
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw problems.tooLarge(maxBytes);
  if (!req.body) throw problems.badRequest("request body required");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) { await reader.cancel(); throw problems.tooLarge(maxBytes); }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return { raw, value: JSON.parse(raw) }; } catch { throw problems.badRequest("body is not valid JSON"); }
}

export async function readRaw(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw problems.tooLarge(maxBytes);
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.length > maxBytes) throw problems.tooLarge(maxBytes);
  return Buffer.from(buf).toString("utf8");
}
