import type {
	ExtensionAPI,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { errorMessage } from "../runtime/errors.ts";
import type { Subagents } from "../runtime/index.ts";
import { sessionOwner } from "./sessions.ts";

const MAX_DEPTH_SETTING = "subagents.maxDepth";

export function maxDepthSetting(settings: object): number | undefined {
	if (!("subagents" in settings)) return undefined;
	const section = settings.subagents;
	if (!section || typeof section !== "object" || !("maxDepth" in section))
		return undefined;
	const value = section.maxDepth;
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number" && Number.isInteger(value) && value >= 1)
		return value;
	throw new Error(
		`Setting ${MAX_DEPTH_SETTING} must be a positive integer, not ${JSON.stringify(value)}.`,
	);
}

export function configuredMaxDepth(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): number | undefined {
	try {
		return maxDepthSetting(pi.getSettings());
	} catch (error) {
		ctx.ui.notify(
			`${errorMessage(error)} Ignoring ${MAX_DEPTH_SETTING}: subagent depth is unlimited.`,
			"error",
		);
		return undefined;
	}
}

export function registerDepthCommand(
	pi: ExtensionAPI,
	runtimeFor: (ctx: ExtensionContext) => Subagents | undefined,
): void {
	pi.registerCommand("subagents-depth", {
		description:
			"Show or override session nesting depth: /subagents-depth [N|unlimited|reset]",
		handler: async (args, ctx) => {
			const tree = runtimeFor(ctx);
			if (!tree) throw new Error("Subagents are not initialized.");
			const value = args.trim();
			if (value === "reset") tree.setMaxDepth();
			else if (value === "unlimited") tree.setMaxDepth(Infinity);
			else if (value) {
				if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
					ctx.ui.notify(
						"Expected a positive integer, unlimited, or reset.",
						"error",
					);
					return;
				}
				tree.setMaxDepth(Number(value));
			}
			ctx.ui.notify(
				`Subagent max depth: ${tree.maxDepth === Infinity ? "unlimited" : tree.maxDepth}.`,
				"info",
			);
		},
	});
}

export function registerSpawnTool<Params extends TSchema, Details>(
	pi: ExtensionAPI,
	tool: ToolDefinition<Params, Details>,
): void {
	const owner = sessionOwner(pi.events);
	if (!owner) {
		pi.registerTool(tool);
		return;
	}

	// Don't expose a never-allowed tool. When lifting a temporary restriction,
	// restore it only if it was active before the restriction.
	let state: "unregistered" | "allowed" | "restore" | "keep-inactive" =
		"unregistered";
	const sync = () => {
		if (owner.runtime.canSpawn(owner.id)) {
			if (state === "unregistered") pi.registerTool(tool);
			else if (state === "restore") {
				const active = pi.getActiveTools();
				if (!active.includes(tool.name))
					pi.setActiveTools([...active, tool.name]);
			}
			state = "allowed";
		} else if (state === "allowed") {
			const active = pi.getActiveTools();
			state = active.includes(tool.name) ? "restore" : "keep-inactive";
			if (state === "restore")
				pi.setActiveTools(active.filter((name) => name !== tool.name));
		}
	};
	sync();
	let unsubscribe: (() => void) | undefined;
	pi.on("session_start", () => {
		unsubscribe?.();
		unsubscribe = owner.runtime.onMaxDepthChange(sync);
		sync();
	});
	pi.on("session_shutdown", () => unsubscribe?.());
}
