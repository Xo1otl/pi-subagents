# pi-subagents

Delegate tasks to pi sessions and follow them in an interactive switcher.

## Load

From the meta-repo root:

```sh
pi -e ./tools/pi-subagents/index.ts
```

Or install the local package:

```sh
pi install ./tools/pi-subagents
```

## Use

Ask pi to delegate a task:

```text
spawn subagent with: "say hello"
```

The `subagent` tool starts a fresh conversation in the same workspace, using the current model and thinking level, and returns its final result. Include task context in the instructions. Agents can delegate further, and siblings can run concurrently.

## Switcher

Run `/subagents` or press **Ctrl+Shift+A**, even during a run. `/subagents 1.2` selects a specific agent.

- **Tab / Shift+Tab**: switch agents.
- **PageUp / PageDown**: scroll the transcript.
- **Enter**: send a message; steer an active run or continue a completed conversation.
- **Ctrl+C**: stop the selected agent and its descendants.
- **Esc**: close the switcher.

## Depth

The default maximum depth is **5**, with the initial session at depth **0**.

```sh
pi -e ./tools/pi-subagents/index.ts --subagent-max-depth 3
```

Change it during the session with `/subagents depth 3`. Existing runs continue; the new limit applies when spawning.

## Development

```sh
cd tools/pi-subagents
bun install
bun run test
bun run typecheck
bunx biome check .
```
