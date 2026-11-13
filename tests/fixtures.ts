import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	contentText,
	createAssistantMessageEventStream,
	type JsonObject,
	type Model,
	type Provider,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionContext,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	KeybindingsManager,
	stripTerminalSequences,
	type Terminal,
	Text,
	TUI_KEYBINDINGS,
	TuiAltScreen,
} from "@earendil-works/pi-tui";
import {
	createSubagentIntegration,
	createSubagentRuntime,
	type SubagentView,
} from "../agent/index.ts";
import { SUBAGENT_RESUME_TYPE } from "../agent/protocol.ts";
import { errorMessage } from "../runtime/errors.ts";
import type { SpawnContext, Subagents } from "../runtime/index.ts";
import { SWITCHER_OVERLAY } from "../ui/switcher.ts";
import protocolFixture, {
	lastCompletion,
	lastCustomMessage,
} from "./protocol.ts";

export {
	completionOutput,
	lastCompletion,
	lastCustomMessage,
} from "./protocol.ts";

// Preloaded through bunfig.toml, so these hooks cover every test file.
// Pi can still write into a test's directory after it ends (e.g. a model
// catalog refresh), so the whole tree is removed once, after the last file.
const root = mkdtempSync(join(tmpdir(), "pi-subagents-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Gates left closed by a test, opened first so that no cleanup waits on them. */
const gates: (() => void)[] = [];
/** Resources, released in reverse order of acquisition. */
const cleanups: (() => unknown)[] = [];
/** Globals read by generated extensions, which may run until their session ends. */
const sharedKeys: symbol[] = [];
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
	for (const key of sharedKeys.splice(0))
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

/** Expose a value to generated extension sources, which Pi loads as separate
 * modules, for the current test. Returns the source expression that reads it.
 */
export function shared(value: unknown): string {
	const key = Symbol.for(`pi-subagents.test.${crypto.randomUUID()}`);
	sharedKeys.push(key);
	Reflect.set(globalThis, key, value);
	return `globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})]`;
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

export function lastText(context: TranscriptContext): string {
	const message = context.messages.at(-1);
	return message ? contentText(message.content) : "";
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

export function stream(
	respond: (
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	) => AssistantMessage | Promise<AssistantMessage>,
): Provider["streamSimple"] {
	return (_model, context, options) => {
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
			? response(completion.output)
			: response("", {
					stopReason: "error",
					errorMessage: completion.error ?? completion.output,
				});
	}
	// A resumed task restates its result.
	if (lastCustomMessage(context, SUBAGENT_RESUME_TYPE)) {
		const previous = context.messages.findLast(
			(message) => message.role === "assistant",
		);
		return response(previous ? contentText(previous.content) : "");
	}
	const match = /^nest:(\d+)$/.exec(text);
	if (match && Number(match[1]) > 0) {
		return toolCall("subagent", {
			instructions: `nest:${Number(match[1]) - 1}`,
		});
	}
	return response(text === "nest:0" || text === "say hello" ? "hello" : text);
});

/** A stream that runs until aborted. */
export const paused = stream((_context, options) => waiting(options?.signal));

export function testProvider(streamFn = hierarchyStream): Provider {
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
	streamFn = hierarchyStream,
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

/** Install an extension, given as its default export's body, for children. */
export async function childExtension(
	{ agentDir }: { agentDir: string },
	name: string,
	body: string,
): Promise<void> {
	await writeFile(
		join(agentDir, "extensions", `${name}.js`),
		`export default function(pi) {\n${body}\n}`,
	);
}

export interface ParentOptions {
	streamFn?: Provider["streamSimple"];
	/** The root's own extensions. */
	extensions?: ExtensionFactory[];
	/** Runs on each child's session_start, which delays its initialization. */
	onChildStart?: (ctx: ExtensionContext) => Promise<void>;
	/** Loads into each child session. */
	onChildLoad?: ExtensionFactory;
	/** Long-lived by default; one-shot modes wait for delegated results before settling. */
	mode?: ExtensionContext["mode"];
}

/** A root SDK session, with the same deterministic provider available to
 * children, shut down after the test.
 */
export async function parentSession({
	streamFn = hierarchyStream,
	extensions = [],
	onChildStart,
	onChildLoad,
	mode = "rpc",
}: ParentOptions = {}) {
	const context = await spawnContext(streamFn);
	const child = shared({
		provider: testProvider(streamFn),
		onChildStart,
		onChildLoad,
	});
	await childExtension(
		context,
		"provider",
		`const shared = ${child};
		pi.registerProvider(shared.provider);
		shared.onChildLoad?.(pi);
		if (shared.onChildStart) pi.on("session_start", (_event, ctx) => shared.onChildStart(ctx));`,
	);
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
	await session.bindExtensions({ mode, shutdownHandler: () => {} });
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
	const release = deferred();
	await childExtension(
		context,
		"blocking",
		`pi.registerTool({
			name: "blocking", label: "Blocking", description: "Blocks until released",
			parameters: { type: "object", properties: {} },
			async execute(_id, _args, signal) {
				await Promise.race([
					${shared(release.promise)},
					new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
				]);
				return { content: [{ type: "text", text: "tool done" }], details: undefined };
			},
		});`,
	);
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

export async function until(
	predicate: () => boolean,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("Timed out waiting for test state");
}

/** pi's fullscreen renderer on a fake terminal, below a long root transcript.
 * Input goes through the real dispatcher, including overlay mouse routing.
 */
export function fullscreen({ columns = 100, rows = 24 } = {}) {
	let send = (_data: string) => {};
	let lastWrite = "";
	const terminal: Terminal = {
		columns,
		rows,
		kittyProtocolActive: false,
		start(onInput) {
			send = onInput;
		},
		stop() {},
		drainInput: async () => {},
		write(data) {
			lastWrite = data;
		},
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
		/** The hardware cursor that the last frame placed, if any. */
		cursor(): { row: number; col: number } | undefined {
			tui.renderNow();
			// The cursor move just before hiding/showing it and ending the frame.
			const match =
				// biome-ignore lint/suspicious/noControlCharactersInRegex: Terminal escape sequences.
				/\x1b\[(\d+);(\d+)H\x1b\[\?25[hl]\x1b\[\?2026l$/.exec(lastWrite);
			return match
				? { row: Number(match[1]) - 1, col: Number(match[2]) - 1 }
				: undefined;
		},
	};
	return harness;
}
