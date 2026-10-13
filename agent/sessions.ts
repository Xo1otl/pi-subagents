import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SessionOwner, SpawnContext } from "../runtime/index.ts";

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
	extension: ExtensionFactory,
): Promise<AgentSession> {
	const agentDir = context.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.create(context.cwd, agentDir, {
		projectTrusted: context.projectTrusted,
	});
	// Use the supported decision hook rather than changing the configured policy.
	// Idle refreshes must not add charges after this run's result was captured.
	const ownedWarming: ExtensionFactory = (pi) => {
		pi.on("cache_warming_decision", () => {
			if (owner.runtime.get(owner.id)?.status !== "running")
				return { action: "stop" };
		});
	};
	const resourceLoader = new DefaultResourceLoader({
		cwd: context.cwd,
		agentDir,
		settingsManager,
		extensionFactories: [
			ownedWarming,
			// A configured installation takes precedence, without duplicate registrations.
			// Otherwise children receive only the machine-facing extension, not the UI entrypoint.
			{
				name: "subagents",
				factory: extension,
				replaceable: true,
			},
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
	// Publication transfers cleanup to the runtime, including failed binding.
	onCreated(session);
	await session.bindExtensions({
		mode: "print",
		shutdownHandler: () => owner.runtime.abort(owner.id),
	});
	return session;
}

export async function disposeChildSession(
	session: AgentSession,
): Promise<void> {
	try {
		await session.extensionRunner.emit({
			type: "session_shutdown",
			reason: "quit",
		});
	} finally {
		owners.delete(session.sessionManager);
		session.dispose();
	}
}
