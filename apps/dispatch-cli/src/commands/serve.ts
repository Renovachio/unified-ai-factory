/** Internal: runs a managed service inside this same executable (so an installed binary needs no separate runtime). Not a user command. */
export async function cmdServe(which: string): Promise<number> {
  if (which === "api") { await import("../../../api/src/server"); return await new Promise<number>(() => undefined); }
  console.error(`unknown internal service "${which}"`); return 2;
}
