const tty = () => !!process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: number) => (s: string) => (tty() ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = { green: c(32), yellow: c(33), red: c(31), dim: c(2), bold: c(1), cyan: c(36) };
export const sym = { ok: () => color.green("✓"), warn: () => color.yellow("!"), fail: () => color.red("✗"), none: () => color.dim("–") };
export const HEADER = () => `${color.cyan("◆")} ${color.bold("DISPATCH")} — AI PRODUCT & SOFTWARE FACTORY`;
/** Strip control characters from anything that came from the server/project data before printing it (terminal-escape injection). */
export const safe = (s: string): string => Array.from(s, (ch) => { const n = ch.charCodeAt(0); return n < 32 || (n >= 127 && n <= 159) ? "·" : ch; }).join("");
