import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	contentText,
	createAssistantMessageEventStream,
	getCurrentTools,
	type JsonObject,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type ExtensionFactory,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	KeybindingsManager,
	stripTerminalSequences,
	type Terminal,
	Text,
	TUI_KEYBINDINGS,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createSubagentIntegration,
	createSubagentRuntime,
	type SubagentView,
} from "../agent/index.ts";
import { REPORT_TOOL } from "../agent/protocol.ts";
import { errorMessage } from "../runtime/errors.ts";
import type { SpawnContext, Subagent, Subagents } from "../runtime/index.ts";
import { SUBAGENT_USAGE_KIND } from "../runtime/summary.ts";
import { SWITCHER_OVERLAY } from "../ui/switcher.ts";
import protocolFixture, {
	isProtocolMessage,
	lastCompletion,
} from "./protocol.ts";

export {
	completionOutput,
	hasCustomMessage,
	lastCompletion,
	lastCustomMessage,
} from "./protocol.ts";

// Preloaded through bunfig.toml, so these hooks cover every test file.
// Pi can still write into a test's directory after it ends (e.g. a model
// catalog refresh), so the whole tree is removed once, after the last file.
const root = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// Markdown follows Pi's active theme, which is global: set it once for every
// file rather than leaving it to whichever test happens to run first.
initTheme("dark");

/** Gates left closed by a test, opened first so that no cleanup waits on them. */
const gates: (() => void)[] = [];
/** Resources, released in reverse order of acquisition. */
const cleanups: (() => unknown)[] = [];
/** Globals through which generated modules reach the test's own extensions. */
const extensionKeys: symbol[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
	for (const open of gates.splice(0)) open();
	const errors: unknown[] = [];
	for (const cleanup of cleanups.splice(0).reverse()) {
		try {
			await cleanup();
		} catch (error) {
			errors.push(error);
		}
	}
	for (const key of extensionKeys.splice(0))
		Reflect.deleteProperty(globalThis, key);
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	if (errors.length) throw new AggregateError(errors, "Test cleanup failed.");
});

/** Release a resource after the current test, before those acquired earlier. */
export function onCleanup(cleanup: () => unknown): void {
	cleanups.push(cleanup);
}

/** A gate the test opens; one left closed opens after the test. */
export function deferred() {
	const gate = Promise.withResolvers<void>();
	gates.push(() => gate.resolve());
	return gate;
}

/** A point that a response, tool or hook blocks at until the test opens it,
 * or its signal aborts. `reached` tells whether anything got there yet.
 */
export function checkpoint() {
	const gate = deferred();
	let reached = false;
	return {
		get reached() {
			return reached;
		},
		async pass(signal?: AbortSignal): Promise<void> {
			reached = true;
			await Promise.race([gate.promise, waiting(signal)]);
		},
		open: () => gate.resolve(),
	};
}

/** Whether a promise is still pending once work that nothing gates has had
 * time to finish. No event marks that something did not happen, so this
 * waits briefly: it can miss a regression, but never fails a correct run.
 */
export async function stillPending(
	promise: Promise<unknown>,
): Promise<boolean> {
	const pending = Symbol("pending");
	const outcome = await Promise.race([
		promise.then(
			() => undefined,
			() => undefined,
		),
		Bun.sleep(10).then(() => pending),
	]);
	return outcome === pending;
}

/** Remove a completion's full-output file after the test. */
export function removeOutputOnCleanup(path: string): void {
	onCleanup(() => rm(dirname(path), { recursive: true, force: true }));
}

/** Kill a process group, unless it is already gone. */
export function killGroup(pgid: number): void {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/** A theme that leaves text uncolored. */
export const theme = { fg: (_color: string, text: string) => text } as Theme;

type CustomMessage = Extract<AgentMessage, { role: "custom" }>;

/** A transcript's custom messages of one type. */
export function customMessages(
	messages: readonly AgentMessage[] | undefined,
	customType: string,
): CustomMessage[] {
	return (messages ?? []).filter(
		(message): message is CustomMessage =>
			message.role === "custom" && message.customType === customType,
	);
}

/** The delegated runs billed to a session's ledger. */
export function charges(session: AgentSession) {
	return session.sessionManager
		.getEntries()
		.filter(
			(entry) => entry.type === "usage" && entry.kind === SUBAGENT_USAGE_KIND,
		);
}

/** Whether an agent has a tool call in flight. */
export function hasRunningTool(node: Subagent | undefined): boolean {
	return [...(node?.liveTools.values() ?? [])].some(
		(tool) => tool.status === "running",
	);
}

/** A runtime with Pi's session lifecycle, shut down after the test. */
export function testRuntime(): Subagents {
	const runtime = createSubagentRuntime();
	onCleanup(() => runtime.dispose());
	return runtime;
}

export const model: Model<"openai-responses"> = {
	id: "test-model",
	name: "Test model",
	provider: "test-provider",
	api: "openai-responses",
	baseUrl: "https://unused.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

/** A complete response; each costs 3 tokens unless `overrides` says otherwise. */
export function response(
	text: string,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		provider: model.provider,
		model: model.id,
		api: model.api,
		timestamp: Date.now(),
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: {
				input: 0.01,
				output: 0.02,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0.03,
			},
		},
		...overrides,
	};
}

export function toolCall(name: string, args: JsonObject): AssistantMessage {
	return response("", {
		stopReason: "toolUse",
		content: [
			{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args },
		],
	});
}

/** A subagent's report, which delivers `text` and ends its task. */
export function report(
	text: string,
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return { ...toolCall(REPORT_TOOL, { result: text }), ...overrides };
}

/** Whether the agent answering has a parent to report to. */
function canReport(context: TranscriptContext): boolean {
	return getCurrentTools(context.messages).some(
		(tool) => tool.name === REPORT_TOOL,
	);
}

/** A final answer: a subagent reports it, the root replies with it. */
export function answer(
	context: TranscriptContext,
	text: string,
): AssistantMessage {
	return canReport(context) ? report(text) : response(text);
}

export function lastText(context: TranscriptContext): string {
	const message = context.messages.at(-1);
	return message ? contentText(message.content) : "";
}

/** The session's first input: a subagent's task. */
export function taskText(context: TranscriptContext): string {
	const message = context.messages.find((message) => message.role === "user");
	return message ? contentText(message.content) : "";
}

/** Whether the agent is answering the user's input rather than its task or
 * a protocol message: a reply that the task does not end with.
 */
export function chatting(context: TranscriptContext): boolean {
	const last = context.messages.at(-1);
	return (
		last?.role === "user" &&
		!isProtocolMessage(last) &&
		context.messages.findIndex((message) => message.role === "user") <
			context.messages.length - 1
	);
}

/** Every text block that the assistant wrote, in order. */
export function replies(messages: readonly AgentMessage[] = []): string[] {
	return messages.flatMap((message) =>
		message.role === "assistant"
			? message.content.flatMap((part) =>
					part.type === "text" ? [part.text] : [],
				)
			: [],
	);
}

type Respond = (
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessage | Promise<AssistantMessage>;

/** A provider stream answering with `respond`, which other streams can reuse
 * as their fallback.
 */
export function stream(
	respond: Respond,
): Provider["streamSimple"] & { respond: Respond } {
	const streamFn: Provider["streamSimple"] = (_model, context, options) => {
		const output = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			let message: AssistantMessage;
			try {
				message = await respond(context, options);
			} catch (error) {
				message = response("", {
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: errorMessage(error),
				});
			}
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				output.push({
					type: "error",
					reason: message.stopReason,
					error: message,
				});
			} else {
				output.push({ type: "start", partial: message });
				for (const [contentIndex, part] of message.content.entries()) {
					if (part.type !== "text") continue;
					output.push({ type: "text_start", contentIndex, partial: message });
					output.push({
						type: "text_delta",
						contentIndex,
						delta: part.text,
						partial: message,
					});
					output.push({
						type: "text_end",
						contentIndex,
						content: part.text,
						partial: message,
					});
				}
				output.push({
					type: "done",
					reason: message.stopReason as "stop" | "length" | "toolUse",
					message,
				});
			}
			output.end();
		});
		return output;
	};
	return Object.assign(streamFn, { respond });
}

/** Deterministic delegation through full pi sessions and real subagent tools. */
export const hierarchyStream = stream((context) => {
	const last = context.messages.at(-1);
	const text = lastText(context);
	if (last?.role === "toolResult") {
		return last.isError
			? response("", { stopReason: "error", errorMessage: text })
			: response("Delegated work is running.");
	}
	const completion = lastCompletion(context);
	if (completion) {
		return completion.status === "done"
			? answer(context, completion.output)
			: response("", {
					stopReason: "error",
					errorMessage: completion.error ?? completion.output,
				});
	}
	const match = /^nest:(\d+)$/.exec(text);
	if (match && Number(match[1]) > 0) {
		return toolCall("subagent", {
			instructions: `nest:${Number(match[1]) - 1}`,
		});
	}
	const reply = text === "nest:0" || text === "say hello" ? "hello" : text;
	// The user's input is answered; the task is reported.
	return chatting(context) ? response(reply) : answer(context, reply);
});

/** A stream that runs until aborted. */
export const paused = stream((_context, options) => waiting(options?.signal));

export function testProvider(
	streamFn: Provider["streamSimple"] = hierarchyStream,
): Provider {
	return {
		id: model.provider,
		name: "Test provider",
		getModels: () => [model],
		auth: {
			apiKey: {
				name: "Test auth",
				resolve: async () => ({ auth: { apiKey: "test" } }),
			},
		},
		stream: (model, context, options) =>
			streamFn(model, context, { signal: options?.signal }),
		streamSimple: streamFn,
	};
}

const QUIET_SETTINGS = {
	cacheWarming: "off",
	compaction: { enabled: false },
	retry: { enabled: false },
} as const;

/** A fresh workspace and agent directory whose model answers with `streamFn`. */
export async function spawnContext(
	streamFn: Provider["streamSimple"] = hierarchyStream,
): Promise<SpawnContext & { agentDir: string }> {
	// Without the preload (e.g. run from another cwd) the first file removes it.
	await mkdir(root, { recursive: true });
	const directory = await mkdtemp(join(root, "context-"));
	const cwd = join(directory, "workspace");
	const agentDir = join(directory, "agent");
	await mkdir(cwd);
	await mkdir(join(agentDir, "extensions"), { recursive: true });
	await writeFile(
		join(agentDir, "extensions", "protocol.js"),
		`export { default } from ${JSON.stringify(new URL("./protocol.ts", import.meta.url).pathname)};`,
	);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify(QUIET_SETTINGS),
	);
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(testProvider(streamFn));
	return {
		cwd,
		agentDir,
		model,
		thinkingLevel: "high",
		projectTrusted: true,
		modelRuntime,
	};
}

/** Install an extension for children. Pi loads it from their agent directory
 * as a separate module, which exports the factory given, for the current test.
 */
export async function childExtension(
	{ agentDir }: { agentDir: string },
	name: string,
	factory: ExtensionFactory,
): Promise<void> {
	const key = Symbol.for(`pi-subagents.test.${crypto.randomUUID()}`);
	extensionKeys.push(key);
	Reflect.set(globalThis, key, factory);
	await writeFile(
		join(agentDir, "extensions", `${name}.js`),
		`export default globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})];`,
	);
}

/** A configured bash override, e.g. remote execution, which tracking must
 * leave alone.
 */
export const remoteBash: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "bash",
		label: "Remote bash",
		description: "Remote execution",
		parameters: Type.Object({ command: Type.Optional(Type.String()) }),
		promptGuidelines: ["REMOTE_BASH_MARKER"],
		async execute() {
			return {
				content: [{ type: "text", text: "remote result" }],
				details: undefined,
			};
		},
	});
};

interface ParentOptions {
	streamFn?: Provider["streamSimple"];
	/** The root's own extensions. */
	extensions?: ExtensionFactory[];
	/** Runs on each child's session_start, which delays its initialization. */
	onChildStart?: (ctx: ExtensionContext) => Promise<void>;
	/** Loads into each child session. */
	onChildLoad?: ExtensionFactory;
}

/** A root SDK session, with the same deterministic provider available to
 * children, shut down after the test.
 */
export async function parentSession({
	streamFn = hierarchyStream,
	extensions = [],
	onChildStart,
	onChildLoad,
}: ParentOptions = {}) {
	const context = await spawnContext(streamFn);
	await childExtension(context, "provider", (pi) => {
		pi.registerProvider(testProvider(streamFn));
		onChildLoad?.(pi);
		if (onChildStart)
			pi.on("session_start", (_event, ctx) => onChildStart(ctx));
	});
	const settingsManager = SettingsManager.inMemory(QUIET_SETTINGS);
	const resourceLoader = new DefaultResourceLoader({
		cwd: context.cwd,
		agentDir: context.agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noContextFiles: true,
		noPromptTemplates: true,
		noThemes: true,
		extensionFactories: [
			protocolFixture,
			// reload() resets API registrations; restore the root's deterministic provider too.
			(pi) => pi.registerProvider(testProvider(streamFn)),
			...extensions,
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		...context,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(context.cwd),
	});
	onCleanup(async () => {
		try {
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
		} catch {
			// A test may have deliberately invalidated the runner.
		}
		session.dispose();
	});
	// Long-lived and headless, like pi's RPC mode.
	await session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	return session;
}

/** A root session running the integration, after its other extensions.
 * `runtime()` is the one bound to the current session; `tree` the first.
 */
export async function rootSession({
	view,
	...options
}: ParentOptions & { view?: Partial<SubagentView> } = {}) {
	let tool: ReturnType<typeof createSubagentIntegration> | undefined;
	const bound: Subagents[] = [];
	// Shutdown disposes the bound runtime, unless the test invalidated it first.
	onCleanup(() => Promise.all(bound.map((runtime) => runtime.dispose())));
	const session = await parentSession({
		...options,
		extensions: [
			...(options.extensions ?? []),
			(pi) => {
				tool = createSubagentIntegration(pi, {
					bind(runtime, ctx) {
						bound.push(runtime);
						view?.bind?.(runtime, ctx);
					},
					dispose: () => view?.dispose?.(),
				});
				pi.registerTool(tool);
			},
		],
	});
	const runtime = () => {
		const current = bound.at(-1);
		if (!current) throw new Error("Missing root runtime");
		return current;
	};
	return {
		session,
		tree: runtime(),
		runtime,
		/** Call the tool as the root's model would, with its own tool context. */
		execute(
			toolCallId: string,
			args: Parameters<NonNullable<typeof tool>["execute"]>[1],
			signal?: AbortSignal,
		) {
			if (!tool) throw new Error("Missing subagent tool");
			return tool.execute(
				toolCallId,
				args,
				signal,
				undefined,
				session.extensionRunner.createToolContext(toolCallId, signal),
			);
		},
	};
}

/** A child tool that blocks its step until released or cancelled. */
export async function blockingTool(context: { agentDir: string }) {
	const release = checkpoint();
	await childExtension(context, "blocking", (pi) => {
		pi.registerTool({
			name: "blocking",
			label: "Blocking",
			description: "Blocks until released",
			parameters: Type.Object({}),
			async execute(_id, _args, signal) {
				await release.pass(signal);
				return {
					content: [{ type: "text", text: "tool done" }],
					details: undefined,
				};
			},
		});
	});
	return release;
}

/** A reparented shell job whose lifetime is controlled by a file, not timing. */
export function backgroundJob(cwd: string, name: string, launcher = "nohup") {
	const gate = join(cwd, `${name}.release`);
	const group = join(cwd, `${name}.pgid`);
	const finished = join(cwd, `${name}.finished`);
	const script = `while [ ! -f "${gate}" ]; do sleep 0.02; done; printf finished > "${finished}"`;
	return {
		group,
		finished,
		command: `printf '%s\\n' "$$" > "${group}"; ${launcher} bash -c '${script}' </dev/null >/dev/null 2>&1 &`,
		release: () => writeFile(gate, ""),
		/** The process group that the job's shell recorded. */
		pgid: async () => Number((await Bun.file(group).text()).trim()),
	};
}

export function waiting(signal?: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) reject(new Error("aborted"));
		else
			signal?.addEventListener("abort", () => reject(new Error("aborted")), {
				once: true,
			});
	});
}

/** Wait for a state that events lead to, however long they take to arrive. */
export async function until(
	predicate: () => boolean,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error(`Timed out waiting until ${predicate}`);
}

/** pi's fullscreen renderer on a fake terminal, below a long root transcript.
 * Input goes through the real dispatcher, including overlay mouse routing.
 */
export function fullscreen({ columns = 100, rows = 24 } = {}) {
	let send = (_data: string) => {};
	let mounted: Component | undefined;
	const terminal: Terminal = {
		columns,
		rows,
		kittyProtocolActive: false,
		start(onInput) {
			send = onInput;
		},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		setProgramStatus() {},
	};
	const tui = new TuiAltScreen(terminal);
	tui.addChild(
		new Text(
			Array.from({ length: 100 }, (_, i) => `ROOT_TRANSCRIPT ${i}`).join("\n"),
			0,
			0,
		),
	);
	tui.start();
	onCleanup(() => tui.stop());
	const harness = {
		tui,
		/** Pi's default bindings that the UI uses, as ctx.ui.custom() passes them. */
		keybindings: new KeybindingsManager({
			...TUI_KEYBINDINGS,
			"app.interrupt": { defaultKeys: "escape" },
			"app.tools.expand": { defaultKeys: "ctrl+o" },
			"app.thinking.toggle": { defaultKeys: "ctrl+t" },
		}),
		/** Like ctx.ui.custom() with the switcher's overlay options. */
		mount(component: Component) {
			mounted = component;
			const overlay = tui.showOverlay(component, SWITCHER_OVERLAY);
			tui.renderNow();
			return overlay;
		},
		input(data: string) {
			send(data);
			tui.renderNow();
		},
		/** SGR mouse report at zero-based cell coordinates. */
		mouse(button: number, x: number, y: number, release = false) {
			send(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
			tui.renderNow();
		},
		click(x: number, y: number) {
			harness.mouse(0, x, y);
			harness.mouse(0, x, y, true);
		},
		screen(): string[] {
			tui.renderNow();
			return tui
				.getScreenLines()
				.map((line) => stripTerminalSequences(line).trimEnd());
		},
		text: () => harness.screen().join("\n"),
		row(text: string): number {
			const row = harness.screen().findIndex((line) => line.includes(text));
			if (row < 0) throw new Error(`${text} is not visible`);
			return row;
		},
		/** Where the mounted component asks for the cursor, in its own rows:
		 * a focused component marks the position, as pi-tui's contract has it.
		 */
		cursor(): { row: number; col: number } | undefined {
			const lines = mounted?.render(columns) ?? [];
			const row = lines.findIndex((line) => line.includes(CURSOR_MARKER));
			const line = lines[row];
			if (line === undefined) return undefined;
			return {
				row,
				col: visibleWidth(line.slice(0, line.indexOf(CURSOR_MARKER))),
			};
		},
	};
	return harness;
}
