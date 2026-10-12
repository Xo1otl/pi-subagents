import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Subagents } from "./runtime.ts";

export interface SessionOwner {
	runtime: Subagents;
	id: string;
}

export interface SpawnContext
	extends Pick<CreateAgentSessionOptions, "agentDir" | "modelRuntime"> {
	cwd: string;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	projectTrusted: boolean;
}

// Pi's extension loader can evaluate another copy of this module.
const key = Symbol.for("pi-subagents.owners");
const shared = globalThis as typeof globalThis & {
	[key]?: WeakMap<ExtensionContext["sessionManager"], SessionOwner>;
};
shared[key] ??= new WeakMap();
const owners = shared[key];

export function sessionOwner(ctx: ExtensionContext): SessionOwner | undefined {
	return owners.get(ctx.sessionManager);
}

export function spawnContext(ctx: ExtensionContext): SpawnContext {
	if (!ctx.model) throw new Error("Select a model before spawning a subagent.");
	const owner = sessionOwner(ctx);
	return {
		...owner?.runtime.get(owner.id)?.context,
		cwd: ctx.cwd,
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel,
		projectTrusted: ctx.isProjectTrusted(),
	};
}

export async function createChildSession(
	context: SpawnContext,
	owner: SessionOwner,
	onCreated: (session: AgentSession) => void,
): Promise<AgentSession> {
	const agentDir = context.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.create(context.cwd, agentDir, {
		projectTrusted: context.projectTrusted,
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: context.cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [
			fileURLToPath(new URL("./index.ts", import.meta.url)),
		],
		extensionFactories: [
			{
				name: "codemode",
				factory: createCodemodeExtension(),
				builtin: true,
				replaceable: true,
			},
			{
				name: "tool-search",
				factory: createToolSearchExtension(),
				builtin: true,
				replaceable: true,
			},
			{
				name: "mcp",
				factory: createMcpExtension(),
				builtin: true,
				replaceable: true,
			},
		],
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.inMemory(context.cwd);
	owners.set(sessionManager, owner);
	const { session } = await createAgentSession({
		cwd: context.cwd,
		agentDir,
		model: context.model,
		thinkingLevel: context.thinkingLevel,
		modelRuntime: context.modelRuntime,
		settingsManager,
		resourceLoader,
		sessionManager,
	});
	try {
		onCreated(session);
		await session.bindExtensions({
			mode: "print",
			shutdownHandler: () => owner.runtime.abort(owner.id),
		});
		return session;
	} catch (error) {
		session.dispose();
		throw error;
	}
}
