import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	matchesKey,
	type OverlayOptions,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { Subagents } from "../runtime/index.ts";
import { type Chat, createChat } from "./chat.ts";
import { createPasteGuard } from "./navigation.ts";
import { createPicker } from "./picker.ts";
import type { UITheme } from "./text.ts";

/** Content-sized: the picker sits over pi's editor, a chat covers the screen. */
export const SWITCHER_OVERLAY: OverlayOptions = {
	width: "100%",
	anchor: "bottom-left",
};

export interface SubagentSwitcherProps {
	runtime: Subagents;
	tui: TUI;
	theme: UITheme;
	keybindings: Pick<KeybindingsManager, "matches">;
	onClose: () => void;
	/** Open this agent's chat instead of the picker. */
	initialId?: string;
}

export interface SubagentSwitcher extends Component, Focusable {
	handleInput(data: string): void;
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
	dispose(): void;
}

/** Pick a subagent, then chat with it on its own screen. */
export function createSubagentSwitcher({
	runtime,
	tui,
	theme,
	keybindings,
	onClose,
	initialId,
}: SubagentSwitcherProps): SubagentSwitcher {
	// Keyed like React state: each agent keeps its chat across switches.
	const chats = new Map<string, Chat>();
	const isPaste = createPasteGuard();
	let chosen = initialId;
	let screen: "picker" | "chat" = initialId ? "chat" : "picker";
	let focused = false;
	let closed = false;

	const selected = () => chosen ?? runtime.tree()[0]?.id;

	function show(id: string | undefined, next = screen): void {
		chosen = id;
		screen = next;
		// Only the visible chat's composer shows a cursor.
		const active = activeChat();
		for (const chat of chats.values())
			chat.focused = focused && chat === active;
	}

	const picker = createPicker({
		runtime,
		theme,
		keybindings,
		selected,
		onSelect: (id) => show(id),
		onOpen: (id) => show(id, "chat"),
	});

	function chatFor(id: string): Chat {
		let chat = chats.get(id);
		if (!chat) {
			chat = createChat({
				id,
				runtime,
				tui,
				theme,
				keybindings,
				onBack: () => show(id, "picker"),
			});
			chats.set(id, chat);
		}
		return chat;
	}

	/** The open chat, or undefined on the picker. */
	function activeChat(): Chat | undefined {
		const id = selected();
		return !closed && screen === "chat" && id ? chatFor(id) : undefined;
	}

	function cycle(delta: number): string | undefined {
		const nodes = runtime.tree();
		const index = nodes.findIndex((node) => node.id === selected());
		return nodes[(index + delta + nodes.length) % nodes.length]?.id;
	}

	function stop(): void {
		const id = selected();
		if (!id) return;
		// Like pi's interrupt, undelivered messages return to each agent's draft.
		for (const [agent, input] of runtime.abort(id))
			chatFor(agent).restore(input);
	}

	function dispose(): void {
		if (closed) return;
		closed = true;
		unsubscribe();
		for (const chat of chats.values()) chat.dispose();
		chats.clear();
	}

	function close(): void {
		if (closed) return;
		dispose();
		onClose();
	}

	const unsubscribe = runtime.subscribe(() => {
		if (runtime.closed) close();
		else tui.requestRender();
	});

	return {
		get focused() {
			return focused;
		},
		set focused(value) {
			focused = value && !closed;
			show(chosen);
		},
		handleInput(data) {
			if (closed) return;
			const chat = activeChat();
			// The picker has no text field to paste into.
			if (isPaste(data)) chat?.paste(data);
			else if (keybindings.matches(data, "app.interrupt")) close();
			else if (matchesKey(data, "tab")) show(cycle(1));
			else if (matchesKey(data, "shift+tab")) show(cycle(-1));
			else if (matchesKey(data, "ctrl+c")) stop();
			else (chat ?? picker).handleInput(data);
		},
		handleMouse(event) {
			if (closed) return undefined;
			const result = (activeChat() ?? picker).handleMouse(event);
			// A wheel over the switcher must not scroll pi's transcript underneath.
			return (
				result ??
				(event.type === "wheel" ? { handled: true, render: false } : undefined)
			);
		},
		render(width) {
			if (closed) return [];
			const height = Math.max(1, tui.terminal.rows);
			return (activeChat() ?? picker)
				.render(Math.max(1, width), height)
				.slice(0, height)
				.map((line) => truncateToWidth(line, width, ""));
		},
		invalidate() {
			for (const chat of chats.values()) chat.invalidate();
		},
		dispose,
	};
}
