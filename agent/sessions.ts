import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	createEventBus,
	createMcpExtension,
	createToolSearchExtension,
	DefaultResourceLoader,
	type EventBus,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionFactory,
	getAgentDir,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SessionOwner, SpawnContext } from "../runtime/index.ts";

/** Each delegated session has its own event bus, which answers this request.
 * Unlike module state, the bus reaches every copy of this extension, including
 * a configured installation that Pi's loader evaluates separately.
 */
const OWNER_REQUEST = "pi-subagents:owner";

interface OwnerRequest {
	owner?: SessionOwner;
}

/** The subagent a loading extension serves; undefined in a root session. */
export function sessionOwner(events: EventBus): SessionOwner | undefined {
	const request: OwnerRequest = {};
	// Bus handlers run synchronously within emit.
	events.emit(OWNER_REQUEST, request);
	return request.owner;
}

/** Children inherit their parent's configuration, then its current selections. */
export function spawnContext(
	ctx: ExtensionContext,
	owner?: SessionOwner,
): SpawnContext {
	if (!ctx.model) throw new Error("Select a model before spawning a subagent.");
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
	onError: (error: ExtensionError) => void,
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
	const eventBus = createEventBus();
	eventBus.on(OWNER_REQUEST, (request) => {
		(request as OwnerRequest).owner = owner;
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd: context.cwd,
		agentDir,
		settingsManager,
		eventBus,
		appendSystemPromptOverride: (base) => [
			...base,
			"Skip default skill-file loading for direct `skill://` paths.",
		],
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
		onError,
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
		session.dispose();
	}
}
