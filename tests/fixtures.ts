import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
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
import type { SpawnContext } from "../runtime/index.ts";
import { SWITCHER_OVERLAY } from "../ui/switcher.ts";

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
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
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
					errorMessage: error instanceof Error ? error.message : String(error),
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
				message.content.forEach((part, contentIndex) => {
					if (part.type === "text") {
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
				});
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
	const completion = /^Subagent [\d.]+ (done|error|aborted)\.\n([\s\S]*)$/.exec(
		text,
	);
	if (completion) {
		return completion[1] === "done"
			? response(completion[2] ?? "")
			: response("", { stopReason: "error", errorMessage: completion[2] });
	}
	const match = /^nest:(\d+)$/.exec(text);
	if (match && Number(match[1]) > 0) {
		return toolCall("subagent", {
			instructions: `nest:${Number(match[1]) - 1}`,
		});
	}
	return response(text === "nest:0" || text === "say hello" ? "hello" : text);
});

const directories: string[] = [];
const sharedKeys: symbol[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
	for (const key of sharedKeys.splice(0))
		Reflect.deleteProperty(globalThis, key);
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

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

export async function spawnContext(
	streamFn = hierarchyStream,
): Promise<SpawnContext> {
	const directory = await mkdtemp(join(tmpdir(), "pi-subagents-test-"));
	directories.push(directory);
	const cwd = join(directory, "workspace");
	const agentDir = join(directory, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(
		join(agentDir, "settings.json"),
		JSON.stringify({
			cacheWarming: "off",
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
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

export function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

/** A root SDK session, with the same deterministic provider available to children.
 * Long-lived by default; one-shot modes wait for delegated results before settling.
 */
export async function parentSession(
	streamFn: Provider["streamSimple"],
	extensionFactories: ExtensionFactory[],
	onChildStart?: (ctx: ExtensionContext) => Promise<void>,
	onChildLoad?: ExtensionFactory,
	mode: ExtensionContext["mode"] = "rpc",
) {
	const context = await spawnContext(streamFn);
	if (!context.agentDir) throw new Error("Missing test agent directory");
	const key = Symbol.for(`pi-subagents.fixture.${crypto.randomUUID()}`);
	sharedKeys.push(key);
	Reflect.set(globalThis, key, {
		provider: testProvider(streamFn),
		onChildStart,
		onChildLoad,
	});
	await mkdir(join(context.agentDir, "extensions"));
	await writeFile(
		join(context.agentDir, "extensions", "provider.js"),
		`export default function(pi) {
			const shared = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})];
			pi.registerProvider(shared.provider);
			shared.onChildLoad?.(pi);
			if (shared.onChildStart) pi.on("session_start", (_event, ctx) => shared.onChildStart(ctx));
		}`,
	);
	const settingsManager = SettingsManager.inMemory({
		cacheWarming: "off",
		compaction: { enabled: false },
		retry: { enabled: false },
	});
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
			// reload() resets API registrations; restore the root's deterministic provider too.
			(pi) => pi.registerProvider(testProvider(streamFn)),
			...extensionFactories,
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		...context,
		settingsManager,
		resourceLoader,
		sessionManager: SessionManager.inMemory(context.cwd),
	});
	await session.bindExtensions({ mode, shutdownHandler: () => {} });
	return session;
}

/** A child tool that blocks its step, like a monitor waiting in a headless session. */
export async function blockingTool(context: SpawnContext, name = "blocking") {
	if (!context.agentDir) throw new Error("Missing test agent directory");
	const release = deferred();
	const key = Symbol.for(`pi-subagents.blocking.${crypto.randomUUID()}`);
	sharedKeys.push(key);
	Reflect.set(globalThis, key, release.promise);
	const directory = join(context.agentDir, "extensions");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, `${name}.js`),
		`export default function(pi) {
			pi.registerTool({
				name: ${JSON.stringify(name)}, label: "Blocking", description: "Blocks until released",
				parameters: { type: "object", properties: {} },
				async execute(_id, _args, signal) {
					await Promise.race([
						globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})],
						new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
					]);
					return { content: [{ type: "text", text: "tool done" }], details: undefined };
				},
			});
		}`,
	);
	return release;
}

/** pi-monitor's contract: one-shot modes wait inside the tool; others end the turn and
 * report later as a "monitor-result" message, unless monitor_stop ends it silently.
 */
export async function fakeMonitor(context: SpawnContext) {
	if (!context.agentDir) throw new Error("Missing test agent directory");
	const finished = deferred();
	const key = Symbol.for(`pi-subagents.monitor.${crypto.randomUUID()}`);
	sharedKeys.push(key);
	Reflect.set(globalThis, key, finished.promise);
	const directory = join(context.agentDir, "extensions");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "monitor.js"),
		`export default function(pi) {
			const finished = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(key))})];
			const active = new Set();
			let next = 0;
			const result = { type: "text", text: "status=success" };
			pi.registerTool({
				name: "monitor_start", label: "Monitor", description: "Background monitor",
				parameters: { type: "object", properties: {} },
				async execute(_id, _args, _signal, _onUpdate, ctx) {
					const monitorId = "monitor_" + ++next;
					if (ctx.mode === "print" || ctx.mode === "json") {
						await finished;
						return { content: [result], details: { monitorId } };
					}
					active.add(monitorId);
					finished.then(() => {
						if (active.delete(monitorId))
							pi.sendMessage(
								{ customType: "monitor-result", content: [result], display: true, details: {} },
								{ deliverAs: "steer", triggerTurn: true },
							);
					});
					return { content: [{ type: "text", text: "Monitor started" }], details: { monitorId }, terminate: true };
				},
			});
			pi.registerTool({
				name: "monitor_stop", label: "Stop monitors", description: "Stop monitors",
				parameters: { type: "object", properties: {} },
				async execute() {
					const stopped = active.size;
					active.clear();
					return { content: [{ type: "text", text: "Stopped " + stopped + " monitor(s)." }], details: { stopped } };
				},
			});
		}`,
	);
	return finished;
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
		stop: () => tui.stop(),
	};
	return harness;
}
