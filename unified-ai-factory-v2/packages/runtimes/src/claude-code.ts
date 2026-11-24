import { SubscriptionCliAdapter, type SubscriptionCliOptions } from "./cli";

/**
 * Claude Code (official CLI) adapter. Shipped DISABLED: `config/provider-terms.json` has no approval for `claude-code`, so every probe
 * and run is refused with `terms-not-approved` until an operator records one (see docs/adr/0002 and docs/third-party/provider-terms/).
 * The default argv is a starting point that MUST be verified against the installed version before use (version is allowlisted by regex).
 */
export const CLAUDE_CODE_ID = "claude-code";

export class ClaudeCodeSubscriptionCliAdapter extends SubscriptionCliAdapter {
  constructor(o: Omit<SubscriptionCliOptions, "id" | "buildArgs"> & { buildArgs?: SubscriptionCliOptions["buildArgs"] }) {
    super({
      ...o, id: CLAUDE_CODE_ID,
      // Non-interactive print mode, JSON envelope, prompt on stdin, no permission bypass flags. UNVERIFIED defaults.
      buildArgs: o.buildArgs ?? ((req) => ["-p", "--output-format", "json", "--model", req.modelId, "--max-turns", "20"]),
    });
  }
}
