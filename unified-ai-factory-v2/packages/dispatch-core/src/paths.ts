import { homedir } from "node:os";
import { join } from "node:path";

export interface DispatchPaths { home: string; config: string; state: string; lock: string; logs: string; secrets: string; token: string; agentToken: string; pgData: string; pgSocket: string; history: string }

/** Application data location (macOS: ~/Library/Application Support/Dispatch; elsewhere XDG). `DISPATCH_HOME` overrides (tests, relocation). */
export function dispatchPaths(env: Record<string, string | undefined> = process.env, platform: string = process.platform): DispatchPaths {
  const home = env.DISPATCH_HOME ?? (platform === "darwin" ? join(homedir(), "Library", "Application Support", "Dispatch") : join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "dispatch"));
  // A unix socket path must fit in ~103 bytes (sockaddr_un); a long home directory falls back to a private per-user directory under /tmp.
  const sock = join(home, "pg", "sock");
  const pgSocket = Buffer.byteLength(join(sock, ".s.PGSQL.54329")) > 100 ? join("/tmp", `dispatch-${typeof process.getuid === "function" ? process.getuid() : "u"}`, "sock") : sock;
  return {
    home, config: join(home, "config.json"), state: join(home, "state.json"), lock: join(home, "start.lock"), logs: join(home, "logs"), secrets: join(home, "secrets"),
    token: join(home, "secrets", "local-owner-token"), agentToken: join(home, "secrets", "local-agent-token"), pgData: join(home, "pg", "data"), pgSocket, history: join(home, "history"),
  };
}
