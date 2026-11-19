# pi-subagents

Async, hierarchical subagents for pi, with a TUI switcher.

## Install

```sh
pi install ./tools/pi-subagents   # or: pi -e ./tools/pi-subagents/index.ts
```

## Tools

| Tool | Behavior |
|---|---|
| `subagent(instructions, model?, effort?)` | Starts a headless session in the same workspace and returns `{ id, status: "running" }` at once. The result arrives later as a `subagent-result` message: batched while the parent is busy, never dropped by interrupts, long output saved to a file. |
| `report_to_parent(result)` | Subagents only. The latest report becomes the result once the run has nothing left to wait for. Refused while child subagents run, and once while tracked jobs run; reporting again leaves those jobs running, untracked. |

## Behavior

- While serving its parent's task, a subagent's system prompt has a `<subagent_role>` section.
- An idle subagent with nothing to wait for and no report gets a `subagent-reminder`; still unreported, its run fails.
- Input to a running agent steers it. Continuing a finished one is your own conversation: no role, no reminder, no delivered report.
- Interrupting an agent ends its turn, not its run: queued input returns to the draft, children and jobs keep running, their results wait, and your next input resumes it. Stopping ends the run and its descendants'.
- Usage is billed to every ancestor session.
- Child sessions are saved as `<parent>/<child>.jsonl`. Switching sessions, reloading or exiting cancels runs; they are not restored.
- One-shot modes (`-p`, `--mode json`) are unsupported.

### Background jobs (POSIX)

- Bash process groups, including `&`/`nohup` jobs, are tracked. `bg-exit` wakes the agent; `bg-unknown` follows 60s of unreadable status.
- A subagent's run waits for its jobs; stopping it or shutting down kills them, except those its report left running. The root's jobs and `!` commands are never killed (`!!` is untracked).
- Top-level foreground `sleep`s totaling 25s or more are refused.
- Untracked: `setsid`/`setpgid`, overridden `bash`, Windows.

## Switcher

`/subagents [id]`, Ctrl+Shift+A, or Left Left at the start of the editor. Requires fullscreen `tuiMode`.

| Key | Picker | Chat |
|---|---|---|
| Up / Down | Select | |
| Left / Right | Parent / child, open | |
| Enter | Open | Send (steer or continue) |
| Shift+Enter, Ctrl+J | | Newline |
| Left Left | | Back to picker |
| PgUp / PgDn, Ctrl+Home / End | | Scroll, start / live |
| Ctrl+O / Ctrl+T | | Toggle tools / thinking |
| Tab / Shift+Tab | Next / previous agent | Next / previous agent |
| Ctrl+C | Interrupt agent; again: stop it and descendants | Interrupt agent; again: stop it and descendants |
| Esc | Close | Close |

## Development

```sh
bun install
bun run test && bun run typecheck && bun run lint
```

Layers: `runtime/` (headless execution) ← `agent/` (pi integration, tools) ← `ui/` (switcher; reaches `agent/` only via `protocol.ts`). Biome enforces them and forbids import cycles.
