import type {
	ExtensionAPI,
	ExtensionContext,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { isViewportTUI } from "@earendil-works/pi-tui";
import { SUBAGENT_RESULT_TYPE } from "../agent/protocol.ts";
import { errorMessage } from "../runtime/errors.ts";
import type { Subagents } from "../runtime/index.ts";
import { bindDoubleLeftNavigation } from "./navigation.ts";
import { bindRunningIndicator } from "./running-indicator.ts";
import { createSubagentSwitcher, SWITCHER_OVERLAY } from "./switcher.ts";
import { renderSubagentCall, renderSubagentResult } from "./tool-renderers.ts";

export function createSubagentUI(pi: ExtensionAPI) {
	let runtime: Subagents | undefined;
	let switcherOpen = false;
	let unbind = () => {};

	function dispose(): void {
		runtime = undefined;
		unbind();
		unbind = () => {};
	}

	async function showSwitcher(
		ctx: ExtensionContext,
		initialId?: string,
	): Promise<void> {
		if (ctx.mode !== "tui")
			throw new Error("The subagent switcher requires pi's terminal UI.");
		if (switcherOpen) return;
		const shown = runtime;
		if (!shown) throw new Error("Subagents are not initialized.");
		if (shown.closed) throw new Error("Subagents have been shut down.");
		if (initialId && !shown.get(initialId))
			throw new Error(`Unknown subagent: ${initialId}`);
		switcherOpen = true;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => {
					if (!isViewportTUI(tui))
						throw new Error(
							'The subagent switcher requires pi\'s fullscreen mode ("tuiMode": "fullscreen").',
						);
					return createSubagentSwitcher({
						runtime: shown,
						tui,
						theme,
						keybindings,
						onClose: () => done(),
						initialId,
					});
				},
				{ overlay: true, overlayOptions: SWITCHER_OVERLAY },
			);
		} finally {
			switcherOpen = false;
		}
	}

	pi.registerMessageRenderer(
		SUBAGENT_RESULT_TYPE,
		({ content, details }, { expanded, outputPad }, theme) => {
			const text = renderSubagentResult(
				{
					content:
						typeof content === "string"
							? [{ type: "text", text: content }]
							: content,
					details,
				},
				{ expanded, isPartial: false },
				theme,
			);
			text.setPaddingX(outputPad);
			return text;
		},
	);
	pi.registerCommand("subagents", {
		description: "Pick a subagent, or chat with one: /subagents [id]",
		handler: (args, ctx) => showSwitcher(ctx, args.trim() || undefined),
	});
	pi.registerShortcut("ctrl+shift+a", {
		description: "Pick a subagent to view (also while the root is running)",
		handler: (ctx) => showSwitcher(ctx),
	});

	return {
		bind(next: Subagents, ctx: ExtensionContext): void {
			dispose();
			runtime = next;
			if (ctx.mode !== "tui") return;
			const clearIndicator = bindRunningIndicator(next, ctx.ui);
			const clearNavigation = bindDoubleLeftNavigation(
				ctx.ui,
				() => !switcherOpen && !next.closed && next.tree().length > 0,
				() => {
					void showSwitcher(ctx).catch((error: unknown) => {
						ctx.ui.notify(errorMessage(error), "error");
					});
				},
			);
			unbind = () => {
				clearIndicator();
				clearNavigation();
			};
		},
		dispose,
		toolRenderers: {
			renderCall: renderSubagentCall,
			renderResult: renderSubagentResult,
		} satisfies ToolRenderers,
	};
}
