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

The `subagent` tool starts a fresh conversation in the same workspace, using the current model and thinking level, and immediately returns a running receipt with the agent ID. The parent can continue working or accept messages while the child starts and runs. Completion arrives separately as a `subagent-result` message, without interrupting an active parent response: results that finish while the parent is busy wait until it settles, then arrive together in one turn. Include task context in the instructions. Agents can delegate further, and siblings can run concurrently. Long results are truncated with a path to the complete output, accessible through file tools; switcher guidance appears only in the UI.

Background jobs outlive the parent turn. Interrupting the parent (for example, to correct a prompt) neither stops them nor drops their results: later results wake the parent as usual, and results already waiting when you interrupt are added to the conversation without restarting the turn. Use **Ctrl+C** in the switcher to stop an agent and its descendants. Changing sessions, reloading, or exiting cancels and cleans up the old jobs. In one-shot modes (`pi -p`, `--mode json`), the root waits for its delegated results before it finishes.

Subagents run as headless, long-lived sessions, so background tools behave as in the main chat: a [pi-monitor](https://www.npmjs.com/package/@fradser/pi-monitor) monitor returns at once and you can keep talking to the agent. Its run stays open, and its final reply reaches the parent, only after its monitors report or are stopped. **Ctrl+C** stops waiting; the monitor processes themselves stop when the session ends.

While any subagent is active, the main screen shows a live indicator above the editor with running/stopping counts, agent IDs, and the switcher shortcut. It includes nested and restarted agents, works with the switcher closed, and disappears when all runs settle.

## Switcher

Run `/subagents`, press **Ctrl+Shift+A**, or press **Left Arrow twice quickly** (within 500 ms) at the beginning of the text, even during a run. `/subagents 1.2` selects a specific agent. Double Left opens with the tree focused; the command and shortcut start in the message input.

The switcher fills the terminal, with the subagent tree on the left and a Markdown conversation and Pi-style multiline editor on the right. Very narrow terminals use a stacked layout. Tool calls and results are grouped into compact, individually collapsible blocks. Command logs stream while tools are running, including nested tools. The root transcript shows background receipts and compact completion previews; expand tools for more output or open the switcher for the conversation.

Incoming output follows the bottom only while viewing live output. Scrolling up anchors the visible content instead of pushing it away as new text arrives. Each agent retains its scroll bookmark, tool expansion state, editor cursor, undo/history, and unsent draft while the switcher is open.

- **Left Arrow twice quickly** at the beginning of the message text: focus the tree. Elsewhere, Left only moves the text cursor.
- **Up / Down** in the tree: select the previous/next agent. **Left** selects its parent; **Right** selects its first child, or returns to the message input for a leaf. **Enter** returns to the message input without sending.
- **Click an agent in the tree**: select it and focus its message input (fullscreen terminal mode); drafts are preserved.
- **Tab / Shift+Tab**: switch agents, including in regular terminal mode.
- **Mouse wheel** over the conversation: scroll the transcript (fullscreen terminal mode).
- **PageUp / PageDown**: scroll the transcript; **Ctrl+Home** jumps to the beginning; **Ctrl+End** returns to live output.
- **Click a tool header**: collapse/expand that tool's arguments and output. Logs remain selectable. **Ctrl+O** expands/collapses all tools in the selected conversation.
- **Ctrl+T**: show/hide thinking, independently of tool expansion.
- **Shift+Enter / Ctrl+J**: insert a newline; backslash followed by Enter also works in terminals without Shift+Enter support. Multiline paste, editing, undo, and prompt history use Pi's standard editor.
- **Enter**: send a message; steer an active run or continue a completed conversation, including a parent waiting for descendants. Steering waits for the current step, such as a long-running tool, and stays visible as *queued* until it is delivered. Continuing a stopped/completed conversation bills its new usage to all ancestors without sending another result to its parent.
- **Ctrl+C**: stop the selected agent and its descendants. Queued messages that were never delivered return to each agent's draft.
- **Esc**: close the switcher.

Fullscreen sizing hides the root UI, but pi's current overlay text selection can still copy across both pane columns.

## Development

- `index.ts`: composition of the agent and UI integrations.
- `runtime/`: non-blocking start, execution, hierarchy, cancellation, queued input, and raw live tool snapshots (`index.ts`); run results and delegated-usage billing, both writing and reading the usage entry (`summary.ts`). Every run bills its local usage delta to captured ancestor ledgers; summaries include descendant charges without rebilling them. Session creation, disposal, and the root ledger are injected, with no imports from `agent/` or `ui/`. Consumers get read-only `Subagent` views; run bookkeeping stays private.
- `agent/`: Pi session creation/ownership and background-monitor tracking (`sessions.ts`), lifecycle and the model-facing tool (`index.ts`), completion formatting and full-output files (`completions.ts`), and the message/receipt protocol shared with the UI (`protocol.ts`, pure data). The lifecycle binds an optional `SubagentView` to root sessions only. Children use a UI-free inline extension unless a configured installation replaces it.
- `ui/`: commands, shortcuts, switcher, running indicator, editor, cached transcript rendering, and semantic scroll anchoring. Receives the runtime only through `SubagentView.bind` and reaches `agent/` only through `protocol.ts`. Human-facing guidance stays here, never in generated tool content.
- `tests/`: runtime, session, and UI tests; `architecture.test.ts` enforces the layering and the absence of import cycles.

```sh
cd tools/pi-subagents
bun install
bun run test
bun run typecheck
bunx biome check .
```
