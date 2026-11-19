# Dispatch commands

Outside the prompt: `dispatch` (start/attach, open dashboard unless `--no-browser`, enter the prompt), `start`, `status`, `doctor`, `stop [--yes]`, `migrate [--yes]`, `--help`, `--version`.
(On macOS the program is `dispatch`, not `/dispatch`, which would address the filesystem root.)

Inside the prompt: `/help /new /projects /project use <id|owner/name> /jobs /status /models /skills /agents /approvals /approve <id> /pause <id> /resume <id> /cancel <id> /logs <id> /dashboard /context [clear] /exit /shutdown`.

- A job reference is a full id, a unique id prefix (6+ chars) or a unique title fragment. Anything ambiguous lists the candidates and does nothing.
- `/cancel` and `/approve` ask for a separate typed confirmation that is bound to the revision you were shown; if the job changed meanwhile nothing happens.
- `/exit` (or Ctrl-D) detaches and leaves the factory and its jobs running. `/shutdown` stops only services Dispatch started, after warning about in-flight jobs.
- Unknown `/commands` are never sent to a model or a shell; you get suggestions.
- Plain sentences: a fixed set of phrases ("show my jobs", "list models", "status") is matched without any model. Everything else is refused unless a qualified, authorized interpreter is configured (none is). Even then its output is schema-validated and can only *propose*; mutations still need your confirmation.
- `/new` is blocked until a repository can be linked (needs the GitHub App). `/approve` decides capability approvals for the exact digests shown; job-merge decisions are made in the dashboard because they bind to an exact commit.
- Not persisted: command history (so secrets typed at the prompt are never written to disk). The session scope (active project, remembered ids) is stored 0600 and expires after 8 h.
