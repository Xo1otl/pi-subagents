import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	matchesKey,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Subagents } from "../runtime/index.ts";
import { ChatEditor, type ChatTUI, fitComposer } from "./composer.ts";
import { atTextStart, createDoubleLeftDetector } from "./navigation.ts";
import { singleLine } from "./text.ts";
import {
	type ChatTheme,
	createTranscriptRenderer,
	type TranscriptLayout,
	type TranscriptPreferences,
} from "./transcript.ts";
import {
	createTranscriptViewport,
	type TranscriptViewport,
} from "./viewport.ts";

export interface SubagentSwitcher extends Component, Focusable {
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	dispose(): void;
}

export type SwitcherFocus = "tree" | "conversation";

export interface SubagentSwitcherOptions {
	runtime: Subagents;
	tui: ChatTUI;
	theme: ChatTheme;
	keybindings: Pick<KeybindingsManager, "matches">;
	onClose: () => void;
	initialId?: string;
	initialFocus?: SwitcherFocus;
}

interface Conversation {
	editor: ChatEditor;
	viewport: TranscriptViewport;
	renderer: ReturnType<typeof createTranscriptRenderer>;
	preferences: TranscriptPreferences & { toolExpanded: Map<string, boolean> };
	error: string;
}

interface MouseLayout {
	treeStart: number;
	treeEnd: number;
	agentRows: ReadonlyMap<number, string>;
	conversationX: number;
	conversationWidth: number;
	transcriptY: number;
	transcriptHeight: number;
	transcript: TranscriptLayout;
	toolRows: ReadonlyMap<number, string>;
	composerY: number;
	composerHeight: number;
	composerOffset: number;
}

function splitTreeWidth(width: number, height: number): number {
	return width >= 40 && height >= 5
		? Math.min(40, Math.max(18, Math.floor(width * 0.32)))
		: 0;
}

function keyHints(focus: SwitcherFocus, width: number): string {
	const candidates =
		focus === "tree"
			? [
					"Tree",
					"Esc close",
					"↑↓ select",
					"← parent",
					"→ child/input",
					"Enter message",
				]
			: [
					"Enter send",
					width < 75 ? "Ctrl+J newline" : "Shift+Enter newline",
					"Esc close",
					"Ctrl+O tools",
					"PgUp/PgDn",
					"Ctrl+C stop",
					"←← tree (at text start)",
					"Tab switch",
					"Ctrl+End live",
					"Ctrl+T thinking",
				];
	const parts: string[] = [];
	for (const hint of candidates)
		if (visibleWidth([...parts, hint].join(" · ")) <= width) parts.push(hint);
	return parts.join(" · ");
}

/** Display live child events without owning execution or a second terminal renderer. */
export function createSubagentSwitcher({
	runtime,
	tui,
	theme,
	keybindings,
	onClose,
	initialId,
	initialFocus = "conversation",
}: SubagentSwitcherOptions): SubagentSwitcher {
	const conversations = new Map<string, Conversation>();
	const doubleLeft = createDoubleLeftDetector();
	let selected = initialId ?? runtime.tree()[0]?.id;
	let focus = initialFocus;
	let focused = false;
	let finished = false;
	let pasting = false;
	let mousePressedId: string | undefined;
	// Hit-testing always uses the last displayed frame, not newly arriving output.
	let mouseLayout: MouseLayout | undefined;
	let unsubscribe = () => {};

	function conversation(): Conversation {
		const id = selected ?? "";
		let chat = conversations.get(id);
		if (!chat) {
			const editor = new ChatEditor(tui, theme);
			chat = {
				editor,
				viewport: createTranscriptViewport(),
				renderer: createTranscriptRenderer(theme),
				preferences: {
					expandTools: false,
					showThinking: false,
					toolExpanded: new Map(),
				},
				error: "",
			};
			conversations.set(id, chat);
			const target = chat;
			editor.onChange = () => {
				if (selected === id) tui.requestRender();
			};
			editor.onSubmit = (text) => {
				if (finished || !id || !text.trim()) return;
				editor.addToHistory(text);
				target.viewport.follow();
				target.error = "";
				void runtime.send(id, text).catch((error: unknown) => {
					if (finished) return;
					target.error = error instanceof Error ? error.message : String(error);
					// Preserve failed input, without replacing a newer draft.
					if (!editor.getText()) editor.setText(text);
					if (selected === id) tui.requestRender();
				});
				tui.requestRender();
			};
		}
		chat.editor.focused = focused && focus === "conversation";
		return chat;
	}

	function focusMarker(pane: SwitcherFocus): string {
		return focused && focus === pane ? `${theme.fg("accent", "●")} ` : "  ";
	}

	function dispose(): void {
		if (finished) return;
		finished = true;
		unsubscribe();
		unsubscribe = () => {};
		for (const chat of conversations.values()) {
			chat.editor.onSubmit = undefined;
			chat.editor.onChange = undefined;
			chat.editor.focused = false;
			chat.renderer.invalidate();
		}
		conversations.clear();
		focused = false;
		doubleLeft.reset();
		mouseLayout = undefined;
		mousePressedId = undefined;
	}

	function finish(): void {
		if (finished) return;
		dispose();
		onClose();
	}

	function focusPane(pane: SwitcherFocus): void {
		focus = pane;
		conversation().editor.focused = focused && pane === "conversation";
		doubleLeft.reset();
	}

	function selectAgent(id: string): void {
		if (id === selected || !runtime.get(id)) return;
		conversation().editor.focused = false;
		selected = id;
		conversation();
		doubleLeft.reset();
		mouseLayout = undefined;
	}

	function switchBy(delta: number, wrap = true): void {
		const nodes = runtime.tree();
		if (!nodes.length) return;
		const index = Math.max(
			0,
			nodes.findIndex((node) => node.id === selected),
		);
		const next = index + delta;
		const id =
			nodes[
				wrap
					? (next + nodes.length) % nodes.length
					: Math.max(0, Math.min(next, nodes.length - 1))
			]?.id;
		if (id) selectAgent(id);
	}

	function scrollBy(delta: number): void {
		if (!mouseLayout || mouseLayout.transcriptHeight === 0) return;
		conversation().viewport.scrollBy(
			mouseLayout.transcript,
			mouseLayout.transcriptHeight,
			delta,
		);
	}

	function holdViewport(): void {
		if (mouseLayout)
			conversation().viewport.hold(
				mouseLayout.transcript,
				mouseLayout.transcriptHeight,
			);
	}

	function toggleTool(id: string): void {
		const chat = conversation();
		holdViewport();
		chat.preferences.toolExpanded.set(
			id,
			!(chat.preferences.toolExpanded.get(id) ?? chat.preferences.expandTools),
		);
	}

	unsubscribe = runtime.subscribe(() => {
		if (runtime.closed) finish();
		else {
			selected ??= runtime.tree()[0]?.id;
			tui.requestRender();
		}
	});

	return {
		get focused() {
			return focused;
		},
		set focused(value) {
			focused = value && !finished;
			if (!finished)
				conversation().editor.focused = focused && focus === "conversation";
			if (!value) doubleLeft.reset();
		},
		handleInput(data) {
			if (finished) return;
			const chat = conversation();
			const canNavigate = focus === "conversation" && atTextStart(chat.editor);
			if (!canNavigate || pasting || data.includes("\x1b[200~"))
				doubleLeft.reset();
			// Never interpret control characters inside bracketed paste as chat shortcuts.
			if (pasting || data.includes("\x1b[200~")) {
				pasting = !data.includes("\x1b[201~");
				chat.editor.handleInput(data);
			} else if (keybindings.matches(data, "app.interrupt")) {
				finish();
				return;
			} else if (canNavigate && doubleLeft.matches(data)) focusPane("tree");
			else if (matchesKey(data, "tab")) switchBy(1);
			else if (matchesKey(data, "shift+tab")) switchBy(-1);
			else if (
				keybindings.matches(data, "tui.altScreen.pageUp") ||
				keybindings.matches(data, "tui.editor.pageUp")
			)
				scrollBy(-Math.max(1, (mouseLayout?.transcriptHeight ?? 10) - 1));
			else if (
				keybindings.matches(data, "tui.altScreen.pageDown") ||
				keybindings.matches(data, "tui.editor.pageDown")
			)
				scrollBy(Math.max(1, (mouseLayout?.transcriptHeight ?? 10) - 1));
			else if (keybindings.matches(data, "tui.altScreen.halfPageUp"))
				scrollBy(
					-Math.max(1, Math.floor((mouseLayout?.transcriptHeight ?? 10) / 2)),
				);
			else if (keybindings.matches(data, "tui.altScreen.halfPageDown"))
				scrollBy(
					Math.max(1, Math.floor((mouseLayout?.transcriptHeight ?? 10) / 2)),
				);
			else if (keybindings.matches(data, "tui.altScreen.lineUp")) scrollBy(-1);
			else if (keybindings.matches(data, "tui.altScreen.lineDown")) scrollBy(1);
			else if (keybindings.matches(data, "tui.altScreen.top")) {
				if (mouseLayout) chat.viewport.top(mouseLayout.transcript);
			} else if (keybindings.matches(data, "tui.altScreen.bottom"))
				chat.viewport.follow();
			else if (keybindings.matches(data, "app.tools.expand")) {
				holdViewport();
				chat.preferences.expandTools = !chat.preferences.expandTools;
				chat.preferences.toolExpanded.clear();
			} else if (keybindings.matches(data, "app.thinking.toggle")) {
				holdViewport();
				chat.preferences.showThinking = !chat.preferences.showThinking;
			} else if (matchesKey(data, "ctrl+c")) {
				if (selected) runtime.abort(selected);
			} else if (focus === "tree") {
				if (
					matchesKey(data, "up") ||
					keybindings.matches(data, "tui.select.up")
				)
					switchBy(-1, false);
				else if (
					matchesKey(data, "down") ||
					keybindings.matches(data, "tui.select.down")
				)
					switchBy(1, false);
				else if (matchesKey(data, "left")) {
					const parent = selected && runtime.get(selected)?.parentId;
					if (parent) selectAgent(parent);
				} else if (matchesKey(data, "right")) {
					const child = runtime
						.tree()
						.find((entry) => entry.parentId === selected);
					if (child) selectAgent(child.id);
					else focusPane("conversation");
				} else if (keybindings.matches(data, "tui.input.submit"))
					focusPane("conversation");
			} else chat.editor.handleInput(data);
			tui.requestRender();
		},
		handleMouse(event) {
			if (finished || !mouseLayout) return;
			const layout = mouseLayout;
			const inConversation =
				event.x >= layout.conversationX &&
				event.x < layout.conversationX + layout.conversationWidth;
			const inTranscript =
				inConversation &&
				event.y >= layout.transcriptY &&
				event.y < layout.transcriptY + layout.transcriptHeight;
			if (event.type === "wheel" && inTranscript && event.wheelDelta) {
				scrollBy(event.wheelDelta);
				return { handled: true, render: true };
			}
			if (event.type === "press" || event.type === "drag")
				mousePressedId = undefined;
			if (event.button !== "left") return;
			if (event.type === "release")
				return mousePressedId ? { handled: true, render: false } : undefined;
			if (event.type !== "press" && event.type !== "click") return;
			const pressedId = mousePressedId;
			if (event.type === "click") mousePressedId = undefined;
			if (
				inConversation &&
				event.y >= layout.composerY &&
				event.y < layout.composerY + layout.composerHeight
			) {
				focusPane("conversation");
				return conversation().editor.handleMouse({
					...event,
					x: event.x - layout.conversationX,
					y: event.y - layout.composerY + layout.composerOffset,
					width: layout.conversationWidth,
				});
			}
			if (event.type === "click" && inTranscript) {
				const id = layout.toolRows.get(event.y);
				if (id) {
					toggleTool(id);
					focusPane("conversation");
					return { handled: true, focus: true };
				}
			}
			if (event.x < layout.treeStart || event.x >= layout.treeEnd) return;
			const id = pressedId ?? layout.agentRows.get(event.y);
			if (!id || !runtime.get(id)) return;
			if (event.type === "press") mousePressedId = id;
			selectAgent(id);
			focusPane("conversation");
			return { handled: true, focus: true };
		},
		render(outerWidth) {
			outerWidth = Math.max(1, outerWidth);
			const outerHeight = Math.max(1, tui.terminal.rows);
			if (finished) return Array<string>(outerHeight).fill("");
			const framed = outerWidth >= 5 && outerHeight >= 8;
			const inset = framed ? 1 : 0;
			const width = outerWidth - inset * 2;
			const height = outerHeight - inset * 2;
			const chat = conversation();
			const treeWidth = splitTreeWidth(width, height);
			const conversationX = treeWidth ? treeWidth + 1 : 0;
			const conversationWidth = width - conversationX;
			const nodes = runtime.tree();
			const node = selected ? runtime.get(selected) : undefined;
			const selectedIndex = Math.max(
				0,
				nodes.findIndex((entry) => entry.id === selected),
			);
			const agentRows = new Map<number, string>();
			const tree: string[] = [];
			const listHeight =
				height < 5
					? 0
					: treeWidth
						? height - 3
						: Math.min(nodes.length, 5, Math.max(0, height - 7));
			const start = Math.max(
				0,
				Math.min(
					selectedIndex - Math.floor(listHeight / 2),
					nodes.length - listHeight,
				),
			);
			if (height >= 5) tree.push(focusMarker("tree") + theme.fg("dim", "Tree"));
			for (const entry of nodes.slice(start, start + listHeight)) {
				agentRows.set(inset + 1 + tree.length, entry.id);
				const label = `${entry.id === selected ? ">" : " "} ${"  ".repeat(entry.depth - 1)}${entry.id} [${entry.status}] ${singleLine(entry.instructions)}`;
				tree.push(theme.fg(entry.id === selected ? "accent" : "muted", label));
			}
			const conversationY = height < 5 ? 0 : 1 + (treeWidth ? 0 : tree.length);
			const editor = fitComposer(
				chat.editor.render(conversationWidth),
				height < 5 ? height : Math.max(1, height - conversationY - 3),
			);
			const bodyHeight =
				height < 5
					? 0
					: Math.max(0, height - conversationY - editor.lines.length - 2);
			const transcript = node
				? chat.renderer.render(node, conversationWidth, chat.preferences)
				: { rows: [] };
			const viewport = chat.viewport.window(transcript, bodyHeight);
			const body = transcript.rows.slice(
				viewport.top,
				viewport.top + bodyHeight,
			);
			const heading =
				chat.error ||
				node?.error ||
				(node
					? `${selectedIndex + 1}/${nodes.length} · ${node.cancelled && node.status === "running" ? "stopping" : node.status}${viewport.following ? " · live" : ` · paused ↓${viewport.maxTop - viewport.top}`}`
					: "No subagents yet.");
			const conversationLines =
				height < 5
					? [...editor.lines]
					: [
							focusMarker("conversation") +
								theme.fg(
									chat.error || node?.error ? "error" : "dim",
									singleLine(heading),
								),
							...body.map((row) => row.text),
							...Array<string>(bodyHeight - body.length).fill(""),
							...editor.lines,
						];
			const lines: string[] = [];
			if (height >= 5)
				lines.push(theme.fg("accent", `Subagents · ${node?.id ?? "none"}`));
			if (treeWidth && height >= 5) {
				for (let row = 0; row < conversationLines.length; row++)
					lines.push(
						truncateToWidth(tree[row] ?? "", treeWidth, "", true) +
							theme.fg("dim", "│") +
							truncateToWidth(
								conversationLines[row] ?? "",
								conversationWidth,
								"",
								true,
							),
					);
			} else lines.push(...tree, ...conversationLines);
			if (height >= 5) lines.push(theme.fg("dim", keyHints(focus, width)));
			const transcriptY = inset + conversationY + (height < 5 ? 0 : 1);
			mouseLayout = {
				treeStart: inset,
				treeEnd: inset + (height < 5 ? 0 : treeWidth || width),
				agentRows,
				conversationX: inset + conversationX,
				conversationWidth,
				transcriptY,
				transcriptHeight: bodyHeight,
				transcript,
				toolRows: new Map(
					body.flatMap((row, index) =>
						row.toolId ? [[transcriptY + index, row.toolId] as const] : [],
					),
				),
				composerY: inset + conversationY + (height < 5 ? 0 : 1 + bodyHeight),
				composerHeight: editor.lines.length,
				composerOffset: editor.offset,
			};
			const clipped = lines.map((line) =>
				truncateToWidth(line, width, "", true),
			);
			if (!framed) return clipped;
			const border = (text: string) => theme.fg("dim", text);
			return [
				border(`╭${"─".repeat(width)}╮`),
				...clipped.map((line) => border("│") + line + border("│")),
				border(`╰${"─".repeat(width)}╯`),
			];
		},
		invalidate() {
			for (const chat of conversations.values()) {
				chat.renderer.invalidate();
				chat.editor.invalidate();
			}
			mouseLayout = undefined;
		},
		dispose,
	};
}
