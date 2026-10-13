import type {
	ExtensionAPI,
	ExtensionContext,
	ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { SUBAGENT_RESULT_TYPE } from "../agent/protocol.ts";
import type { Subagents } from "../runtime/index.ts";
import { bindDoubleLeftNavigation } from "./navigation.ts";
import { bindRunningIndicator } from "./running-indicator.ts";
import { createSubagentSwitcher, type SwitcherFocus } from "./switcher.ts";
import { renderSubagentCall, renderSubagentResult } from "./tool-renderers.ts";

/** Register human controls and expose default tool renderers for composition.
 * The integration owns the session lifecycle and binds the runtime to show;
 * creating the UI starts no timers or subscriptions.
 */
export function createSubagentUI(pi: ExtensionAPI) {
	let runtime: Subagents | undefined;
	let switcherOpen = false;
	let clearIndicator = () => {};
	let clearNavigation = () => {};

	function dispose(): void {
		runtime = undefined;
		clearIndicator();
		clearIndicator = () => {};
		clearNavigation();
		clearNavigation = () => {};
	}

	async function showSwitcher(
		ctx: ExtensionContext,
		initialId?: string,
		initialFocus: SwitcherFocus = "conversation",
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
				(tui, theme, keybindings, done) =>
					createSubagentSwitcher({
						runtime: shown,
						tui,
						theme,
						keybindings,
						onClose: () => done(),
						initialId,
						initialFocus,
					}),
				{
					overlay: true,
					overlayOptions: {
						width: "100%",
						maxHeight: "100%",
						anchor: "top-left",
						margin: 0,
					},
				},
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
		description: "View and message any subagent: /subagents [id]",
		handler: async (args, ctx) => {
			await showSwitcher(ctx, args.trim() || undefined);
		},
	});
	pi.registerShortcut("ctrl+shift+a", {
		description: "Open the subagent switcher (also while the root is running)",
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
			clearIndicator = bindRunningIndicator(next, ctx.ui);
			clearNavigation = bindDoubleLeftNavigation(
				ctx.ui,
				() => !switcherOpen && !next.closed && next.tree().length > 0,
				() => {
					void showSwitcher(ctx, undefined, "tree").catch((error: unknown) => {
						ctx.ui.notify(
							error instanceof Error ? error.message : String(error),
							"error",
						);
					});
				},
			);
		},
		dispose,
		toolRenderers,
	};
}
