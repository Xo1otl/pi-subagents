import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	stripTerminalSequences,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Subagent, Subagents } from "./runtime.ts";

export interface SubagentSwitcher extends Component, Focusable {
	handleInput(data: string): void;
	dispose(): void;
}

export interface SubagentSwitcherOptions {
	runtime: Subagents;
	tui: Pick<TUI, "requestRender"> & {
		terminal: Pick<TUI["terminal"], "rows">;
	};
	theme: Pick<Theme, "fg">;
	keybindings: Pick<KeybindingsManager, "matches">;
	onClose: () => void;
	initialId?: string;
}

interface SwitcherState {
	drafts: Map<string, string>;
	selected?: string;
	scroll: number;
	error: string;
	finished: boolean;
}

interface TranscriptCache {
	id: string;
	revision: number;
	width: number;
	lines: string[];
}

interface SwitcherView {
	nodes: readonly Subagent[];
	node?: Subagent;
	selected?: string;
	maxDepth: number;
	scroll: number;
	error: string;
	width: number;
	height: number;
	transcript: readonly string[];
	input: readonly string[];
	theme: Pick<Theme, "fg">;
}

function plain(text: string): string {
	return stripTerminalSequences(text).replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Remove untrusted terminal control characters.
		/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
		"",
	);
}

function messageText(message: AgentMessage): string {
	if (message.role === "system") return "";
	if ("content" in message) {
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: content
						.map((part) => {
							if (part.type === "text") return part.text;
							if (part.type === "thinking")
								return `[thinking] ${part.thinking}`;
							if (part.type === "toolCall")
								return `${part.name} ${JSON.stringify(part.arguments)}`;
							return `[image: ${part.mimeType}]`;
						})
						.join("\n");
		const label =
			message.role === "toolResult" ? `tool ${message.toolName}` : message.role;
		return `${plain(label)}: ${plain(text)}`;
	}
	return "";
}

function transcriptLines(node: Subagent, width: number): string[] {
	const messages =
		node.session?.sessionManager
			.getEntries()
			.flatMap((entry): AgentMessage[] => {
				if (entry.type === "message") return [entry.message];
				if (entry.type === "custom_message")
					return [
						{
							role: "custom",
							customType: entry.customType,
							content: entry.content,
							display: entry.display,
							details: entry.details,
							timestamp: Date.parse(entry.timestamp),
						},
					];
				return [];
			}) ?? [];
	const streaming = node.session?.state.streamingMessage;
	if (streaming && !messages.includes(streaming)) messages.push(streaming);
	const text = messages.map(messageText).filter(Boolean).join("\n\n");
	return new Text(text || "(starting…)", 0, 0).render(width);
}

function clampScroll(scroll: number, limit = Infinity): number {
	return Math.max(0, Math.min(scroll, limit));
}

/** Derive layout from the current interaction state. */
function renderView(view: SwitcherView) {
	const {
		nodes,
		node,
		selected,
		maxDepth,
		error,
		width,
		height,
		transcript,
		input,
		theme,
	} = view;
	if (height < 4) return { lines: input.slice(0, height), scrollLimit: 0 };
	const clip = (text: string) => truncateToWidth(text, width);
	const lines = [
		clip(
			theme.fg(
				"accent",
				`Subagents · ${node?.id ?? "none"} · depth limit ${maxDepth}`,
			),
		),
	];
	const listHeight = Math.min(nodes.length, 5, Math.max(0, height - 6));
	const selectedIndex = Math.max(
		0,
		nodes.findIndex((entry) => entry.id === selected),
	);
	const start = Math.max(
		0,
		Math.min(
			selectedIndex - Math.floor(listHeight / 2),
			nodes.length - listHeight,
		),
	);
	for (const entry of nodes.slice(start, start + listHeight)) {
		const label = `${entry.id === selected ? ">" : " "} ${"  ".repeat(entry.depth - 1)}${entry.id} [${entry.status}] ${plain(entry.instructions).replace(/\s+/g, " ")}`;
		lines.push(
			clip(theme.fg(entry.id === selected ? "accent" : "muted", label)),
		);
	}
	const heading =
		error ||
		node?.error ||
		(node
			? `${selectedIndex + 1}/${nodes.length} · depth ${node.depth} · parent ${node.parentId}`
			: "No subagents yet.");
	lines.push(
		clip(theme.fg(error || node?.error ? "error" : "dim", plain(heading))),
	);
	const bodyHeight = Math.max(0, height - lines.length - input.length - 1);
	const scrollLimit = Math.max(0, transcript.length - bodyHeight);
	const end = Math.max(
		0,
		transcript.length - clampScroll(view.scroll, scrollLimit),
	);
	const body = transcript.slice(Math.max(0, end - bodyHeight), end);
	lines.push(
		...body.map(clip),
		...Array<string>(bodyHeight - body.length).fill(""),
		...input,
		clip(
			theme.fg(
				"dim",
				"Tab/Shift+Tab switch · PgUp/PgDn scroll · Enter send/steer · Ctrl+C stop subtree · Esc root",
			),
		),
	);
	return { lines, scrollLimit };
}

/** Display live child events in an interactive overlay. */
export function createSubagentSwitcher({
	runtime,
	tui,
	theme,
	keybindings,
	onClose,
	initialId,
}: SubagentSwitcherOptions): SubagentSwitcher {
	const input = new Input({ placeholder: "Message this subagent…" });
	const state: SwitcherState = {
		drafts: new Map(),
		selected: initialId ?? runtime.tree()[0]?.id,
		scroll: 0,
		error: "",
		finished: false,
	};
	// Rendering may update these disposable layout caches, never interaction state.
	let cache: TranscriptCache | undefined;
	let scrollLimit: number | undefined;
	let unsubscribe = () => {};

	function dispose(): void {
		state.finished = true;
		unsubscribe();
		unsubscribe = () => {};
		input.onSubmit = undefined;
		state.drafts.clear();
		cache = undefined;
		scrollLimit = undefined;
	}

	function finish(): void {
		if (state.finished) return;
		dispose();
		onClose();
	}

	function switchBy(delta: number): void {
		const nodes = runtime.tree();
		if (!nodes.length) return;
		if (state.selected) state.drafts.set(state.selected, input.getValue());
		const index = nodes.findIndex((node) => node.id === state.selected);
		state.selected =
			nodes[(Math.max(0, index) + delta + nodes.length) % nodes.length]?.id;
		input.setValue(state.drafts.get(state.selected ?? "") ?? "");
		state.scroll = 0;
		state.error = "";
		scrollLimit = undefined;
	}

	function scrollBy(delta: number): void {
		state.scroll = clampScroll(
			clampScroll(state.scroll, scrollLimit) + delta,
			scrollLimit,
		);
	}

	function transcript(node: Subagent, width: number): string[] {
		if (
			cache?.id === node.id &&
			cache.revision === node.revision &&
			cache.width === width
		) {
			return cache.lines;
		}
		const lines = transcriptLines(node, width);
		cache = { id: node.id, revision: node.revision, width, lines };
		return lines;
	}

	input.onSubmit = (text) => {
		const id = state.selected;
		if (state.finished || !id || !text.trim()) return;
		input.setValue("");
		state.drafts.delete(id);
		state.scroll = 0;
		state.error = "";
		scrollLimit = undefined;
		void runtime.send(id, text).catch((error: unknown) => {
			if (state.finished || state.selected !== id) return;
			state.error = error instanceof Error ? error.message : String(error);
			tui.requestRender();
		});
		tui.requestRender();
	};
	unsubscribe = runtime.subscribe(() => {
		if (runtime.closed) finish();
		else {
			state.selected ??= runtime.tree()[0]?.id;
			scrollLimit = undefined;
			tui.requestRender();
		}
	});

	return {
		get focused() {
			return input.focused;
		},
		set focused(value) {
			input.focused = value;
		},
		handleInput(data) {
			if (state.finished) return;
			if (keybindings.matches(data, "app.interrupt")) {
				finish();
				return;
			}
			if (matchesKey(data, "tab")) switchBy(1);
			else if (matchesKey(data, "shift+tab")) switchBy(-1);
			else if (keybindings.matches(data, "tui.editor.pageUp")) scrollBy(10);
			else if (keybindings.matches(data, "tui.editor.pageDown")) scrollBy(-10);
			else if (matchesKey(data, "ctrl+end")) state.scroll = 0;
			else if (matchesKey(data, "ctrl+c")) {
				if (state.selected) runtime.abort(state.selected);
			} else if (keybindings.matches(data, "tui.input.submit")) {
				input.onSubmit?.(input.getValue());
				return;
			} else input.handleInput(data);
			tui.requestRender();
		},
		render(width) {
			width = Math.max(1, width);
			const height = Math.max(1, Math.floor(tui.terminal.rows * 0.9));
			const node = state.selected ? runtime.get(state.selected) : undefined;
			const view = renderView({
				nodes: runtime.tree(),
				node,
				selected: state.selected,
				maxDepth: runtime.maxDepth,
				scroll: state.scroll,
				error: state.error,
				width,
				height,
				transcript: node && height >= 4 ? transcript(node, width) : [],
				input: input.render(width),
				theme,
			});
			scrollLimit = view.scrollLimit;
			return view.lines;
		},
		invalidate() {
			cache = undefined;
			scrollLimit = undefined;
			input.invalidate();
		},
		dispose,
	};
}
