# pi-subagents

Delegate tasks to pi sessions; follow them in a switcher.

```sh
pi -e ./tools/pi-subagents/index.ts   # or: pi install ./tools/pi-subagents
```

## Delegation

- `subagent` starts a headless session in the same workspace (current model/effort unless `model`/`effort` given) and returns a receipt at once.
- A subagent delivers its result with `report_to_parent`. While its parent's task runs, its system prompt gains one `<subagent_role>` section: only the first message is from its parent, who can't see the chat, and the result goes via `report_to_parent` once the task is done. The report is kept as tool-result state, not picked from the chat, so replies to you or to notices never become the result.
- Result arrives later as `subagent-result`; while the parent is busy, results wait and arrive together. Interrupts never drop them. Long output is truncated, with a path to the full text.
- `report_to_parent` stops the children and command groups still running and tells the agent which; their results and exits no longer reach it, and the parent is not told. The agent judges: its report stands if it lets it, or it fixes what it must and reports again. With nothing left, `report_to_parent` ends the turn at once.
- A run finishes once idle with nothing left to wait for; its latest report goes to the parent.
- An agent idle with nothing to wait for and no report gets a `subagent-reminder`, another only after its tracked work changes (input, a child's result, a job's exit); still unreported, the run fails with its last message attached. One that waits forever without reporting is not detected: stop it.
- If you talk to a running agent, it answers you in the chat, which its parent never sees, then the reminder returns it to its task. A finished conversation you continue is yours: its prompt drops the `<subagent_role>` section, no reminder follows, and a report there is not delivered; usage still bills ancestors.
- One-shot modes (`pi -p`, `--mode json`) are unsupported: pi exits after its reply, cancelling delegated runs.
- Each subagent's session is saved beside its parent's file, in a directory named after it (`<parent>.jsonl` → `<parent>/<child>.jsonl`, nesting likewise), out of `/resume` lists. A parent without a file (`--no-session`) keeps children in memory. Saved sessions are records only: runs are not restored after a restart.
- Changing sessions, reloading, or exiting cancels delegated runs.

## Background jobs (POSIX)

- Bash process groups are tracked, including `&`/`nohup` jobs that outlive their shell. On exit, `bg-exit` wakes the agent if idle, or queues for its next turn. It holds no output or exit code.
- A group whose status cannot be read for a minute gets one `bg-unknown`, delivered the same way. It is neither stopped nor dropped: its `bg-exit` still follows.
- Subagents own their jobs: a run waits for them; a report, Ctrl+C and shutdown stop them.
- The root watches its own jobs and your `!` commands (`!!` stays private), never stopping them.
- Untracked: `setsid`/`setpgid` (detach with `setsid -f cmd`), bash overrides, and other tools' processes. On Windows, nothing is tracked.

## Switcher

Open with `/subagents [id]`, **Ctrl+Shift+A**, or **Left Left** at the start of the editor. Requires fullscreen `tuiMode`. A live indicator above the editor shows active agents.

- **Picker**: tree with status, task, context %. **Up/Down** select, **Left** parent, **Right** child/open, **Enter**/click open.
- **Chat**: **Enter** sends (steers a running agent or continues a finished one), **Shift+Enter**/**Ctrl+J** newline, **Left Left** back to the picker, **PgUp/PgDn**/wheel scroll, **Ctrl+Home/End** start/live, click a tool header to toggle, **Ctrl+O** toggle all, **Ctrl+T** thinking.
- **Both**: **Tab/Shift+Tab** next/previous agent, **Ctrl+C** stop agent and descendants (undelivered input returns to the draft), **Esc** close.

## Development

- `runtime/`: execution, hierarchy, cancellation, input, reports and reminders, billing. Session lifecycle is injected; no imports from `agent/` or `ui/`.
- `agent/`: Pi sessions, command tracking, the `subagent` and `report_to_parent` tools, and `protocol.ts` (shared with the UI).
- `ui/`: switcher, indicator, shortcuts. Reaches `agent/` only via `protocol.ts`.
- `tests/`: `architecture.test.ts` enforces layering.

```sh
bun install && bun run test && bun run typecheck && bun run lint
```
