# pi-subagents

Delegate tasks to pi sessions; follow them in a switcher.

```sh
pi -e ./tools/pi-subagents/index.ts   # or: pi install ./tools/pi-subagents
```

## Delegation

- `subagent` starts a headless session in the same workspace (current model/effort unless `model`/`effort` given) and returns a receipt at once.
- Result arrives later as `subagent-result`; while the parent is busy, results wait and arrive together. Interrupts never drop them.
- A run finishes when it is idle with no running children or command groups; its last message goes to the parent. Long output is truncated, with a path to the full text.
- If you talk to a running agent, it answers, then `subagent-resume` returns it to its task or has it restate its result, whatever happened after your message, so the parent never gets a reply meant for you. A finished conversation you continue is yours: no resume, no new result; usage still bills ancestors.
- One-shot modes (`pi -p`, `--mode json`) wait for all results.
- Changing sessions, reloading, or exiting cancels delegated runs.

## Background jobs (POSIX)

- Bash process groups are tracked, including `&`/`nohup` jobs that outlive their shell. On exit, `bg-exit` wakes the agent if idle, or queues for its next turn. It holds no output or exit code.
- Subagents own their jobs: Ctrl+C and shutdown stop them.
- The root watches its own jobs and your `!` commands (`!!` stays private), never stopping them.
- Untracked: `setsid`/`setpgid`, bash overrides, and other tools' processes. On Windows, nothing is tracked.

## Switcher

Open with `/subagents [id]`, **Ctrl+Shift+A**, or **Left Left** at the start of the editor. Requires fullscreen `tuiMode`. A live indicator above the editor shows active agents.

- **Picker**: tree with status, task, context %. **Up/Down** select, **Left** parent, **Right** child/open, **Enter**/click open.
- **Chat**: **Enter** sends (steers a running agent or continues a finished one), **Shift+Enter**/**Ctrl+J** newline, **Left Left** back to the picker, **PgUp/PgDn**/wheel scroll, **Ctrl+Home/End** start/live, click a tool header to toggle, **Ctrl+O** toggle all, **Ctrl+T** thinking.
- **Both**: **Tab/Shift+Tab** next/previous agent, **Ctrl+C** stop agent and descendants (undelivered input returns to the draft), **Esc** close.

## Development

- `runtime/`: execution, hierarchy, cancellation, input, resume, billing. Session lifecycle is injected; no imports from `agent/` or `ui/`.
- `agent/`: Pi sessions, command tracking, the `subagent` tool, and `protocol.ts` (shared with the UI).
- `ui/`: switcher, indicator, shortcuts. Reaches `agent/` only via `protocol.ts`.
- `tests/`: `architecture.test.ts` enforces layering.

```sh
bun install && bun run test && bun run typecheck && bun run lint
```
