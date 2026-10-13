import { expect, mock, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { createSubagents, ROOT, type SpawnContext } from "../runtime/index.ts";
import { deferred, model, response, until } from "./fixtures.ts";

const context: SpawnContext = { cwd: "/unused", model, projectTrusted: false };

test("runtime owns execution but delegates session creation and disposal", async () => {
	const entries: { type: "message"; message: AssistantMessage }[] = [];
	const unsubscribe = mock(() => {});
	const prompt = mock(async (_instructions: string) => {
		entries.push({ type: "message", message: response("complete output") });
	});
	const session = {
		subscribe: () => unsubscribe,
		prompt,
		waitForIdle: async () => {},
		sessionManager: { getEntries: () => entries },
	} as unknown as AgentSession;
	const disposeSession = mock(async (_session: AgentSession) => {});
	const createSession = mock(
		async (
			_context: SpawnContext,
			_owner: unknown,
			onCreated: (session: AgentSession) => void,
		) => {
			onCreated(session);
			return session;
		},
	);
	const runtime = createSubagents({ createSession, disposeSession });
	try {
		expect(createSession).not.toHaveBeenCalled();
		const result = await runtime.start(ROOT, "task instructions", context)
			.result;
		expect(createSession).toHaveBeenCalledWith(
			context,
			{ runtime, id: "1" },
			expect.any(Function),
			expect.any(Function),
		);
		expect(prompt).toHaveBeenCalledWith("task instructions", {
			streamingBehavior: "steer",
			preflightResult: expect.any(Function),
		});
		expect(result).toMatchObject({
			id: "1",
			status: "done",
			output: "complete output",
		});
		expect(result.usage.totalTokens).toBe(3);
	} finally {
		await runtime.dispose();
		await runtime.dispose();
	}
	expect(disposeSession).toHaveBeenCalledTimes(1);
	expect(disposeSession).toHaveBeenCalledWith(session);
	expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test("session-creation failures remain plain run data", async () => {
	const disposeSession = mock(async (_session: AgentSession) => {});
	const runtime = createSubagents({
		createSession: async () => {
			throw new Error("session unavailable");
		},
		disposeSession,
	});
	try {
		expect(
			await runtime.start(ROOT, "task instructions", context).result,
		).toMatchObject({
			status: "error",
			error: "session unavailable",
			output: "session unavailable",
		});
	} finally {
		await runtime.dispose();
	}
	expect(disposeSession).not.toHaveBeenCalled();
});

test("start reserves a running receipt synchronously, before session initialization", async () => {
	const initialized = deferred();
	const finished = deferred();
	const entries: { type: "message"; message: AssistantMessage }[] = [];
	const session = {
		subscribe: () => () => {},
		prompt: async () => {
			await finished.promise;
			entries.push({ type: "message", message: response("child finished") });
		},
		waitForIdle: async () => {},
		sessionManager: { getEntries: () => entries },
	} as unknown as AgentSession;
	const createSession = mock(
		async (
			_context: SpawnContext,
			_owner: unknown,
			onCreated: (session: AgentSession) => void,
		) => {
			await initialized.promise;
			onCreated(session);
			return session;
		},
	);
	const runtime = createSubagents({
		createSession,
		disposeSession: async () => {},
	});
	try {
		const started = runtime.start(ROOT, "delayed child", context);
		expect(started.id).toBe("1");
		expect(createSession).not.toHaveBeenCalled();
		// A resolved tool-receipt promise also beats the factory's synchronous work.
		await Promise.resolve(started);
		expect(createSession).not.toHaveBeenCalled();
		expect(runtime.get("1")?.status).toBe("running");
		expect(runtime.get("1")?.session).toBeUndefined();
		let settled = false;
		void started.result.then(() => {
			settled = true;
		});
		await until(() => createSession.mock.calls.length === 1);
		expect(settled).toBe(false);
		initialized.resolve();
		await until(() => Boolean(runtime.get("1")?.session));
		expect(settled).toBe(false);
		finished.resolve();
		expect(await started.result).toMatchObject({
			status: "done",
			output: "child finished",
		});
	} finally {
		initialized.resolve();
		finished.resolve();
		await runtime.dispose();
	}
});

test("start validates synchronously without reserving nodes, and shutdown rejects new work", async () => {
	const createSession = mock(async () => {
		throw new Error("should not initialize");
	});
	const runtime = createSubagents({
		createSession,
		disposeSession: async () => {},
	});
	const controller = new AbortController();
	controller.abort(new Error("already cancelled"));
	expect(() =>
		runtime.start(ROOT, "hello", context, controller.signal),
	).toThrow("already cancelled");
	expect(() => runtime.start(ROOT, " ", context)).toThrow("must not be empty");
	expect(() => runtime.start("missing", "hello", context)).toThrow(
		"Unknown parent",
	);
	expect(runtime.tree()).toHaveLength(0);
	expect(createSession).not.toHaveBeenCalled();
	await runtime.dispose();
	expect(() => runtime.start(ROOT, "hello", context)).toThrow("shut down");
	await expect(runtime.send("1", "hello")).rejects.toThrow("shut down");
});

test("cancellation during session initialization prevents prompting and disposes the late session once", async () => {
	const initialized = deferred();
	const entered = deferred();
	const prompt = mock(async () => {});
	const session = {
		subscribe: () => () => {},
		prompt,
		waitForIdle: async () => {},
		abort: async () => {},
		clearQueue: () => {},
		sessionManager: { getEntries: () => [] },
	} as unknown as AgentSession;
	const disposeSession = mock(async () => {});
	const runtime = createSubagents({
		createSession: async (_context, _owner, onCreated) => {
			entered.resolve();
			await initialized.promise;
			onCreated(session);
			return session;
		},
		disposeSession,
	});
	const controller = new AbortController();
	const started = runtime.start(ROOT, "hello", context, controller.signal);
	await entered.promise;
	controller.abort();
	const closing = runtime.dispose();
	initialized.resolve();
	expect((await started.result).status).toBe("aborted");
	await closing;
	expect(prompt).not.toHaveBeenCalled();
	expect(disposeSession).toHaveBeenCalledTimes(1);
});

test("detached initialization failures and rejected completion work are observed without unhandled rejections", async () => {
	const runtime = createSubagents({
		createSession: async () => {
			throw new Error("detached initialization failed");
		},
		disposeSession: async () => {},
	});
	try {
		// Deliberately do not await the result, as a receipt-only consumer would do.
		runtime.start(ROOT, "task", context);
		runtime.trackCompletion(ROOT, Promise.reject(new Error("delivery failed")));
		await until(() => runtime.get("1")?.status === "error");
		expect(runtime.get("1")?.error).toBe("detached initialization failed");
	} finally {
		await expect(runtime.dispose()).rejects.toBeInstanceOf(AggregateError);
	}
});

test("rejected completion work remains an error even when it drains before waitForIdle", async () => {
	const entries: { type: "message"; message: AssistantMessage }[] = [];
	const session = {
		subscribe: () => () => {},
		prompt: async () => {
			runtime.trackCompletion(
				"1",
				Promise.reject(new Error("delivery failed")),
			);
			entries.push({ type: "message", message: response("otherwise done") });
		},
		waitForIdle: async () => {},
		sessionManager: { getEntries: () => entries },
	} as unknown as AgentSession;
	const runtime = createSubagents({
		createSession: async (_context, _owner, onCreated) => {
			onCreated(session);
			return session;
		},
		disposeSession: async () => {},
	});
	try {
		expect(await runtime.start(ROOT, "task", context).result).toMatchObject({
			status: "error",
			error: "delivery failed",
			usage: { totalTokens: 3 },
		});
	} finally {
		await runtime.dispose();
	}
});

test("a send arriving after an idle snapshot but before finalization is drained and billed", async () => {
	const entries: { type: "message"; message: AssistantMessage }[] = [];
	let sent: Promise<void> | undefined;
	let waits = 0;
	const session = {
		subscribe: () => () => {},
		prompt: async (text: string) => {
			entries.push({ type: "message", message: response(text) });
		},
		waitForIdle: async () => {
			if (waits++ === 0)
				queueMicrotask(() => {
					queueMicrotask(() => {
						sent = runtime.send("1", "late input");
					});
				});
		},
		sessionManager: { getEntries: () => entries },
	} as unknown as AgentSession;
	const runtime = createSubagents({
		createSession: async (_context, _owner, onCreated) => {
			onCreated(session);
			return session;
		},
		disposeSession: async () => {},
	});
	try {
		expect(await runtime.start(ROOT, "initial", context).result).toMatchObject({
			output: "late input",
			usage: { totalTokens: 6 },
		});
		await sent;
	} finally {
		await runtime.dispose();
	}
});

test("failed binding revokes a published session and retry creates a fresh one", async () => {
	const entries: { type: "message"; message: AssistantMessage }[] = [];
	const unsubscribe = mock(() => {});
	const failedPrompt = mock(async () => {
		throw new Error("disposed session was reused");
	});
	const failed = {
		subscribe: () => unsubscribe,
		prompt: failedPrompt,
	} as unknown as AgentSession;
	const good = {
		subscribe: () => () => {},
		prompt: async () => {
			entries.push({ type: "message", message: response("retry complete") });
		},
		waitForIdle: async () => {},
		sessionManager: { getEntries: () => entries },
	} as unknown as AgentSession;
	const disposeSession = mock(async (_session: AgentSession) => {});
	let creates = 0;
	const runtime = createSubagents({
		createSession: async (_context, _owner, onCreated) => {
			const session = creates++ === 0 ? failed : good;
			onCreated(session);
			if (session === failed) throw new Error("binding failed");
			return session;
		},
		disposeSession,
	});
	try {
		expect(await runtime.start(ROOT, "initial", context).result).toMatchObject({
			status: "error",
			error: "binding failed",
		});
		expect(runtime.get("1")?.session).toBeUndefined();
		expect(disposeSession).toHaveBeenCalledTimes(1);
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		await runtime.send("1", "retry");
		expect(runtime.get("1")?.session).toBe(good);
		expect(runtime.get("1")?.status).toBe("done");
		expect(creates).toBe(2);
		expect(failedPrompt).not.toHaveBeenCalled();
	} finally {
		await runtime.dispose();
	}
	expect(disposeSession.mock.calls.map(([session]) => session)).toEqual([
		failed,
		good,
	]);
});

test("disposal attempts every session and unsubscribe before reporting cleanup errors", async () => {
	const unsubscribe = mock(() => {
		throw new Error("unsubscribe failed");
	});
	const disposeSession = mock(async (_session: AgentSession) => {
		if (disposeSession.mock.calls.length === 1)
			throw new Error("cleanup failed");
	});
	const runtime = createSubagents({
		createSession: async (_context, _owner, onCreated) => {
			const session = {
				subscribe: () => unsubscribe,
				prompt: async () => {},
				waitForIdle: async () => {},
				sessionManager: { getEntries: () => [] },
			} as unknown as AgentSession;
			onCreated(session);
			return session;
		},
		disposeSession,
	});
	await runtime.start(ROOT, "one", context).result;
	await runtime.start(ROOT, "two", context).result;
	const closing = runtime.dispose();
	expect(runtime.dispose()).toBe(closing);
	await expect(closing).rejects.toMatchObject({
		errors: [
			expect.objectContaining({ message: "cleanup failed" }),
			expect.objectContaining({ message: "unsubscribe failed" }),
			expect.objectContaining({ message: "unsubscribe failed" }),
		],
	});
	expect(disposeSession).toHaveBeenCalledTimes(2);
	expect(unsubscribe).toHaveBeenCalledTimes(2);
	expect(runtime.closed).toBe(true);
	expect(runtime.tree()).toHaveLength(0);
});

test("abort failures are observed and reported at shutdown without skipping disposal", async () => {
	const gate = deferred();
	const session = {
		subscribe: () => () => {},
		prompt: async () => gate.promise,
		waitForIdle: async () => {},
		clearQueue: () => {},
		abort: async () => {
			throw new Error("abort failed");
		},
		sessionManager: { getEntries: () => [] },
	} as unknown as AgentSession;
	const disposeSession = mock(async () => {});
	const runtime = createSubagents({
		createSession: async (_context, _owner, onCreated) => {
			onCreated(session);
			return session;
		},
		disposeSession,
	});
	const started = runtime.start(ROOT, "task", context);
	await until(() => Boolean(runtime.get("1")?.session));
	runtime.abort("1");
	gate.resolve();
	expect((await started.result).status).toBe("aborted");
	await expect(runtime.dispose()).rejects.toMatchObject({
		errors: [expect.objectContaining({ message: "abort failed" })],
	});
	expect(disposeSession).toHaveBeenCalledTimes(1);
});

test("terminal listeners can restart without the old run clearing their operation", async () => {
	const gate = deferred();
	const entries: { type: "message"; message: AssistantMessage }[] = [];
	let restarted: Promise<void> | undefined;
	const session = {
		subscribe: () => () => {},
		prompt: async (text: string) => {
			if (text === "restart") await gate.promise;
			entries.push({ type: "message", message: response(text) });
		},
		waitForIdle: async () => {},
		sessionManager: { getEntries: () => entries },
	} as unknown as AgentSession;
	const runtime = createSubagents({
		createSession: async (_context, _owner, onCreated) => {
			onCreated(session);
			return session;
		},
		disposeSession: async () => {},
	});
	runtime.subscribe(() => {
		if (runtime.get("1")?.status === "done" && !restarted)
			restarted = runtime.send("1", "restart");
	});
	try {
		expect((await runtime.start(ROOT, "initial", context).result).output).toBe(
			"initial",
		);
		expect(restarted).toBeDefined();
		expect(runtime.get("1")?.status).toBe("running");
		gate.resolve();
		await restarted;
		expect(runtime.get("1")?.status).toBe("done");
	} finally {
		gate.resolve();
		await runtime.dispose();
	}
});

test("liveTools retains full raw snapshots, authoritative terminal results, and nested parent IDs until the next run", async () => {
	let listener: (event: AgentSessionEvent) => void = () => {};
	const entries: { type: "message"; message: AssistantMessage }[] = [];
	const first: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "first" }],
		details: { progress: 1 },
	};
	const second: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "replacement" }],
		details: { progress: 2 },
	};
	const final: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "\u001b[31mraw tool output\u001b[0m" }],
		details: { complete: true },
	};
	let runs = 0;
	const session = {
		subscribe: (handler: typeof listener) => {
			listener = handler;
			return () => {};
		},
		prompt: async () => {
			if (runs++ === 0) {
				listener({
					type: "tool_execution_start",
					toolCallId: "call",
					toolName: "outer",
					args: { value: 1 },
				});
				expect(runtime.get("1")?.liveTools.get("call")?.status).toBe("running");
				listener({
					type: "tool_execution_update",
					toolCallId: "call",
					toolName: "outer",
					args: { value: 1 },
					partialResult: first,
				});
				expect(runtime.get("1")?.liveTools.get("call")?.result).toBe(first);
				listener({
					type: "tool_execution_update",
					toolCallId: "call",
					toolName: "outer",
					args: { value: 1 },
					partialResult: second,
				});
				expect(runtime.get("1")?.liveTools.get("call")?.result).toBe(second);
				listener({
					type: "tool_execution_start",
					toolCallId: "call/1",
					toolName: "nested",
					args: { nested: true },
					parentToolCallId: "call",
				});
				listener({
					type: "tool_execution_update",
					toolCallId: "call/1",
					toolName: "nested",
					args: { nested: true },
					partialResult: second,
					parentToolCallId: "call",
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "call/1",
					toolName: "nested",
					result: first,
					isError: true,
					parentToolCallId: "call",
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "call",
					toolName: "outer",
					result: final,
					isError: false,
				});
				entries.push({
					type: "message",
					message: response("", {
						stopReason: "toolUse",
						content: [
							{
								type: "toolCall",
								id: "call",
								name: "outer",
								arguments: { value: 1 },
							},
						],
					}),
				});
			} else expect(runtime.get("1")?.liveTools.size).toBe(0);
			entries.push({ type: "message", message: response("done") });
		},
		waitForIdle: async () => {},
		sessionManager: { getEntries: () => entries },
	} as unknown as AgentSession;
	const runtime = createSubagents({
		createSession: async (_context, _owner, onCreated) => {
			onCreated(session);
			return session;
		},
		disposeSession: async () => {},
	});
	try {
		expect((await runtime.start(ROOT, "tools", context).result).status).toBe(
			"done",
		);
		const tools = runtime.get("1")?.liveTools;
		expect(tools?.get("call")).toMatchObject({
			args: { value: 1 },
			status: "done",
			result: final,
		});
		expect(tools?.get("call/1")).toMatchObject({
			args: { nested: true },
			status: "error",
			result: first,
			parentToolCallId: "call",
		});
		await runtime.send("1", "next run");
		expect(runtime.get("1")?.liveTools).toBe(tools);
		expect(tools?.size).toBe(0);
	} finally {
		await runtime.dispose();
	}
});
