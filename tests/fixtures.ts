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
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SpawnContext } from "../runtime.ts";

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
			: response(text);
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
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(async () => {
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

export function waiting(signal?: AbortSignal): Promise<never> {
	return new Promise((_resolve, reject) => {
		if (signal?.aborted) reject(new Error("aborted"));
		else
			signal?.addEventListener("abort", () => reject(new Error("aborted")), {
				once: true,
			});
	});
}

export async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(1);
	}
	throw new Error("Timed out waiting for test state");
}
