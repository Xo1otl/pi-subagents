import type {
	ExtensionAPI,
	ExtensionContext,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { isViewportTUI } from "@earendil-works/pi-tui";
import { SUBAGENT_RESULT_TYPE } from "../agent/protocol.ts";
import type { Subagents } from "../runtime/index.ts";
import { bindDoubleLeftNavigation } from "./navigation.ts";
import { bindRunningIndicator } from "./running-indicator.ts";
import { createSubagentSwitcher, SWITCHER_OVERLAY } from "./switcher.ts";
import { renderSubagentCall, renderSubagentResult } from "./tool-renderers.ts";

/** Register human controls and expose default tool renderers for composition.
 * The integration owns the session lifecycle and binds the runtime to show;
 * creating the UI starts no timers or subscriptions.
 */
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

	pi.registerMessageRenderer(SUBAGENT_RESULT_TYPE, (message, options, theme) =>
		renderSubagentResult(
			{
				content:
					typeof message.content === "string"
						? [{ type: "text", text: message.content }]
						: message.content,
				details: message.details,
			},
			{ expanded: options.expanded, isPartial: false },
			theme,
		),
	);
	pi.registerCommand("subagents", {
		description: "Pick a subagent, or chat with one: /subagents [id]",
		handler: async (args, ctx) => {
			await showSwitcher(ctx, args.trim() || undefined);
		},
	});
	pi.registerShortcut("ctrl+shift+a", {
		description: "Pick a subagent to view (also while the root is running)",
		handler: (ctx) => showSwitcher(ctx),
	});

	const toolRenderers: ToolRenderers = {
		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,
	};

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
						ctx.ui.notify(
							error instanceof Error ? error.message : String(error),
							"error",
						);
					});
				},
			);
			unbind = () => {
				clearIndicator();
				clearNavigation();
			};
		},
		dispose,
		toolRenderers,
	};
}
