import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createSubagents,
	DEFAULT_MAX_DEPTH,
	parseMaxDepth,
	ROOT,
	type Subagents,
} from "./runtime.ts";
import { sessionOwner, spawnContext } from "./sessions.ts";
import { createSubagentSwitcher } from "./switcher.ts";

const silent: Component = { render: () => [], invalidate: () => {} };

export default function subagentsExtension(pi: ExtensionAPI): void {
	let runtime: Subagents | undefined;
	let switcherOpen = false;

	pi.registerFlag("subagent-max-depth", {
		type: "string",
		default: String(DEFAULT_MAX_DEPTH),
		description:
			"Maximum subagent nesting depth; root is 0 (default: 5, 0 disables spawning)",
	});

	const current = (): Subagents => {
		if (!runtime)
			throw new Error(
				"Subagents are not initialized. Check --subagent-max-depth.",
			);
		return runtime;
	};

	pi.on("session_start", async (_event, ctx) => {
		const owner = sessionOwner(ctx);
		if (owner) {
			runtime = owner.runtime;
			return;
		}
		await runtime?.dispose();
		runtime = undefined;
		runtime = createSubagents(
			parseMaxDepth(
				String(pi.getFlag("subagent-max-depth") ?? DEFAULT_MAX_DEPTH),
			),
		);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		const owner = sessionOwner(ctx);
		if (owner) {
			if (event.reason === "quit") owner.runtime.abort(owner.id);
			else {
				for (const child of owner.runtime.tree())
					if (child.parentId === owner.id) owner.runtime.abort(child.id);
			}
		} else await runtime?.dispose();
		runtime = undefined;
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate a task to a subagent.",
		parameters: Type.Object({
			instructions: Type.String({ minLength: 1 }),
		}),
		executionMode: "parallel",
		async execute(_id, { instructions }, signal, _onUpdate, ctx) {
			return current().spawn(
				sessionOwner(ctx)?.id ?? ROOT,
				instructions,
				spawnContext(ctx),
				signal,
			);
		},
		renderShell: "self",
		renderCall: () => silent,
		renderResult: (result, { isPartial }) =>
			isPartial
				? silent
				: new Text(
						result.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n"),
						0,
						0,
					),
	});

	const showSwitcher = async (
		ctx: ExtensionContext,
		initialId?: string,
	): Promise<void> => {
		if (ctx.mode !== "tui")
			throw new Error("The subagent switcher requires pi's terminal UI.");
		if (switcherOpen) return;
		const tree = current();
		if (initialId && !tree.get(initialId))
			throw new Error(`Unknown subagent: ${initialId}`);
		switcherOpen = true;
		try {
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) =>
					createSubagentSwitcher({
						runtime: tree,
						tui,
						theme,
						keybindings,
						onClose: () => done(),
						initialId,
					}),
				{
					overlay: true,
					overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" },
				},
			);
		} finally {
			switcherOpen = false;
		}
	};

	pi.registerCommand("subagents", {
		description:
			"View and message any subagent: /subagents [id]; set depth: /subagents depth N",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (text.startsWith("depth ")) {
				current().setMaxDepth(parseMaxDepth(text.slice(6).trim()));
				ctx.ui.notify(`Subagent max depth: ${current().maxDepth}`, "info");
				return;
			}
			await showSwitcher(ctx, text || undefined);
		},
	});
	pi.registerShortcut("ctrl+shift+a", {
		description: "Open the subagent switcher (also while the root is running)",
		handler: (ctx) => showSwitcher(ctx),
	});
}
