import { spawn } from "node:child_process";
import type { DispatchConfig } from "@factory/dispatch-core";

/** Only the factory's own loopback origins may ever be opened (never a URL that came from data or a model). */
export function verifiedLocalUrl(url: string, cfg: DispatchConfig): URL | null {
  let u: URL; try { u = new URL(url); } catch { return null; }
  const okOrigin = u.protocol === "http:" && u.hostname === cfg.host && (u.port === String(cfg.ports.web) || u.port === String(cfg.ports.api)) && u.username === "" && u.password === "";
  return okOrigin ? u : null;
}
/** Fire-and-forget OS open with an argument array (no shell). A failure here never changes reported service health. */
export function openBrowser(url: string, cfg: DispatchConfig, platform = process.platform): { opened: boolean; reason?: string } {
  const u = verifiedLocalUrl(url, cfg); if (!u) return { opened: false, reason: "refused: not a verified local dashboard address" };
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? null : "xdg-open"; if (!cmd) return { opened: false, reason: "unsupported platform" };
  try { const c = spawn(cmd, [u.toString()], { stdio: "ignore", detached: true }); c.on("error", () => undefined); c.unref(); return { opened: true }; } catch (e) { return { opened: false, reason: (e as Error).message }; }
}
