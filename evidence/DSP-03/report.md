# DSP-03 — Interactive terminal and slash commands

**Status: in_progress (implemented and verified against the real API and a packaged install; no human-in-a-TTY session recorded).**
Code: `apps/dispatch-cli/src/repl/{repl,executor,session}.ts`, `packages/dispatch-core/src/intent/commands.ts`. Tests: `apps/dispatch-cli/tests/repl.test.ts` (13), `packages/dispatch-core/tests/intent.test.ts`.

- All 19 commands in `COMMANDS.md` exist (`/help /new /projects /project use /jobs /status /models /skills /agents /approvals /approve /pause /resume /cancel /logs /dashboard /context /context clear /exit /shutdown`). Missing/malformed arguments print usage and execute nothing; unknown slash commands get suggestions and are never sent to the API, a model or a shell (asserted: zero requests).
- `/exit` and end-of-input detach; `/shutdown` needs a typed confirmation, warns about in-flight jobs, and only stops services Dispatch owns (verified in DSP-02).
- Real-run evidence (packaged binary, scrubbed env, cwd `/`, piped stdin): `/status`, `/projects`, `/models`, `/skills`, `/approvals`, `show my jobs`, an unrecognised sentence (refused), `/rm -rf /` (unknown command), `/project use acme/clipboard`, `/context`, `/pause`, `/resume`, `/cancel` with wrong then right confirmation (DB row confirmed CANCELLED), `/exit` leaving services running.
- Defects found by the real run and fixed: EOF without `/exit` crashed (`readline was closed`); multi-line output was flattened by control-character stripping; `/project use owner/name` was rejected.
- Completion for slash commands is implemented (TTY only). History is deliberately in-memory only.

**Not verified:** interactive TTY behaviour (completion, Ctrl-C/Ctrl-D) was not exercised by a person; only piped stdin. `/logs` live follow is implemented but tested only for history. `/new` is honestly BLOCKED (needs repository linking).
