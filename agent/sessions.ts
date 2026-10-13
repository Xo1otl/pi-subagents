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

/** Keep a delegated run open while monitors it started in the background are running,
 * so its final reply reflects their results while the agent stays free to converse.
 * pi-monitor's contract: an interactive monitor_start ends the turn with a monitorId, and
 * its terminal result arrives later as a "monitor-result" message unless monitor_stop
 * ends it silently.
 */
function backgroundMonitors(owner: SessionOwner): ExtensionFactory {
	return (pi) => {
		const running: (() => void)[] = [];
		const finish = (count: number) => {
			for (const done of running.splice(0, count)) done();
		};
		pi.on("tool_execution_end", ({ toolName, result, isError }) => {
			if (isError) return;
			if (
				toolName === "monitor_start" &&
				result?.terminate === true &&
				typeof result.details?.monitorId === "string"
			)
				owner.runtime.trackCompletion(
					owner.id,
					new Promise<void>((resolve) => running.push(resolve)),
				);
			else if (toolName === "monitor_stop")
				finish(Number(result?.details?.stopped) || 0);
		});
		pi.on("message_end", ({ message }) => {
			if (message.role === "custom" && message.customType === "monitor-result")
				finish(1);
		});
		// Cancellation stops the wait; session shutdown stops the monitors themselves.
		const unsubscribe = owner.runtime.subscribe(() => {
			if (running.length && owner.runtime.get(owner.id)?.cancelled)
				finish(running.length);
		});
		pi.on("session_shutdown", () => {
			unsubscribe();
			finish(running.length);
		});
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
			backgroundMonitors(owner),
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
	// Headless but long-lived, unlike one-shot print mode: background tools return at
	// once and wake the agent later, as in the main chat.
	await session.bindExtensions({
		mode: "rpc",
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
