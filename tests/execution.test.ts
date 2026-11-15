import { expect, mock, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type AgentSession,
	type AgentSessionEvent,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	createSubagents,
	ROOT,
	type SpawnContext,
	type SubagentsOptions,
} from "../runtime/index.ts";
import { deferred, model, response, until } from "./fixtures.ts";

const context: SpawnContext = { cwd: "/unused", model, projectTrusted: false };

/** The runtime only needs to recognize reports; here they are custom entries. */
const REPORT = "test-report";

function reportOf(entry: SessionEntry): string | undefined {
	return entry.type === "custom" && entry.customType === REPORT
		? String(entry.data)
		: undefined;
}

/** Answer like Pi, and report the answer unless told otherwise. */
function reply(session: AgentSession, text: string, reported = true): void {
	session.sessionManager.appendMessage(response(text));
	if (reported) session.sessionManager.appendCustomEntry(REPORT, text);
}

/** Only the SDK boundary is stubbed; entries use Pi's real ledger. */
function sessionStub(overrides: Partial<AgentSession> = {}): AgentSession {
	const sessionManager = SessionManager.inMemory();
	const session = {
		sessionManager,
		subscribe: () => () => {},
		prompt: async (text: string) => reply(session, text),
		waitForIdle: async () => {},
		abort: async () => {},
		clearQueue: () => ({ steering: [], followUp: [] }),
		...overrides,
	} as AgentSession;
	return session;
}

function runtimeWith(
	options: Pick<SubagentsOptions, "createSession"> & Partial<SubagentsOptions>,
) {
	return createSubagents({
		remindSession: async () => {},
		disposeSession: async () => {},
		reportOf,
		...options,
	});
}

function runtimeFor(
	session: AgentSession,
	options: Partial<SubagentsOptions> = {},
) {
	return runtimeWith({
		createSession: async (_context, _owner, onCreated) => onCreated(session),
		...options,
	});
}

test("runtime owns execution but delegates session creation and disposal", async () => {
	const unsubscribe = mock(() => {});
	const prompt = mock(async (_instructions: string) => {
		reply(session, "complete output");
	});
	const session = sessionStub({ subscribe: () => unsubscribe, prompt });
	const disposeSession = mock(async (_session: AgentSession) => {});
	const createSession = mock<SubagentsOptions["createSession"]>(
		async (_context, _owner, onCreated) => onCreated(session),
	);
	const runtime = runtimeFor(session, { createSession, disposeSession });
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
			usage: { totalTokens: 3 },
		});
	} finally {
		await runtime.dispose();
		await runtime.dispose();
	}
	expect(disposeSession).toHaveBeenCalledTimes(1);
	expect(disposeSession).toHaveBeenCalledWith(session);
	expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test("ledger write failures do not leave completed runs stuck running or prevent reuse", async () => {
	const rootSessionManager = SessionManager.inMemory();
	const appendUsage = rootSessionManager.appendUsage.bind(rootSessionManager);
	rootSessionManager.appendUsage = () => {
		throw new Error("ledger unavailable");
	};
	const runtime = runtimeFor(sessionStub(), { rootSessionManager });
	try {
		await expect(
			runtime.start(ROOT, "initial", context).result,
		).rejects.toThrow("ledger unavailable");
		expect(runtime.get("1")?.status).toBe("done");
		rootSessionManager.appendUsage = appendUsage;
		await runtime.send("1", "resume");
		expect(runtime.get("1")?.status).toBe("done");
		expect(rootSessionManager.getEntries()).toHaveLength(1);
	} finally {
		await runtime.dispose();
	}
});

test("start reserves a running receipt synchronously, before session initialization", async () => {
	const initialized = deferred();
	const finished = deferred();
	const session = sessionStub({
		prompt: async () => {
			await finished.promise;
			reply(session, "child finished");
		},
	});
	const createSession = mock<SubagentsOptions["createSession"]>(
		async (_context, _owner, onCreated) => {
			await initialized.promise;
			onCreated(session);
		},
	);
	const runtime = runtimeFor(session, { createSession });
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
	const runtime = runtimeWith({ createSession });
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
	const session = sessionStub({ prompt });
	const disposeSession = mock(async () => {});
	const runtime = runtimeFor(session, {
		createSession: async (_context, _owner, onCreated) => {
			entered.resolve();
			await initialized.promise;
			onCreated(session);
		},
		disposeSession,
	});
	const started = runtime.start(ROOT, "hello", context);
	await entered.promise;
	runtime.abort("1");
	const closing = runtime.dispose();
	initialized.resolve();
	expect((await started.result).status).toBe("aborted");
	await closing;
	expect(prompt).not.toHaveBeenCalled();
	expect(disposeSession).toHaveBeenCalledTimes(1);
});

test("initialization failures are run data, and orphaned completion failures are reported at shutdown", async () => {
	const disposeSession = mock(async (_session: AgentSession) => {});
	const runtime = runtimeWith({
		createSession: async () => {
			throw new Error("session unavailable");
		},
		disposeSession,
	});
	const { result } = runtime.start(ROOT, "task", context);
	runtime.trackCompletion(ROOT, Promise.reject(new Error("delivery failed")));
	expect(await result).toMatchObject({
		status: "error",
		error: "session unavailable",
		output: "session unavailable",
	});
	await expect(runtime.dispose()).rejects.toMatchObject({
		errors: [expect.objectContaining({ message: "delivery failed" })],
	});
	expect(disposeSession).not.toHaveBeenCalled();
});

test("rejected completion work remains an error even when it drains before waitForIdle", async () => {
	const session = sessionStub({
		prompt: async () => {
			runtime.trackCompletion(
				"1",
				Promise.reject(new Error("delivery failed")),
			);
			reply(session, "otherwise done", false);
		},
	});
	const runtime = runtimeFor(session);
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

test("a send arriving as the run's last work settles is drained and billed", async () => {
	let sent: Promise<void> | undefined;
	const session = sessionStub({
		prompt: async (text) => {
			reply(session, text);
			// Lands just before the microtask that resumes the run's drain.
			if (text === "initial")
				queueMicrotask(() => {
					sent = runtime.send("1", "late input");
				});
		},
	});
	const runtime = runtimeFor(session);
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

test.each([true, false])(
	"an idle task with nothing left to wait for is reminded once to report (reports when reminded: %s)",
	async (heard) => {
		const session = sessionStub({
			prompt: async (text) => reply(session, `re: ${text}`, false),
		});
		const remindSession = mock(async (reminded: AgentSession) => {
			reply(reminded, "task result", heard);
		});
		const runtime = runtimeFor(session, { remindSession });
		try {
			const result = await runtime.start(ROOT, "task", context).result;
			expect(result).toMatchObject(
				heard
					? { status: "done", output: "task result" }
					: {
							status: "error",
							error: "Subagent ended without a report.",
							// The last message tells the parent what the agent was saying.
							output:
								"Subagent ended without a report. Its last message:\n\ntask result",
						},
			);
			expect(remindSession).toHaveBeenCalledTimes(1);
			expect(result).not.toHaveProperty("stopped");
			// A conversation the user continues is theirs: no report, no reminder.
			await runtime.send("1", "continue");
			expect(runtime.get("1")?.status).toBe("done");
			expect(remindSession).toHaveBeenCalledTimes(1);
		} finally {
			await runtime.dispose();
		}
	},
);

test("an ignored reminder is repeated only once the task's work changes, e.g. with input", async () => {
	let sent: Promise<void> | undefined;
	const session = sessionStub({
		prompt: async (text) => reply(session, `re: ${text}`, false),
	});
	const remindSession = mock(async (reminded: AgentSession) => {
		const first = remindSession.mock.calls.length === 1;
		reply(reminded, first ? "still working" : "task result", !first);
		if (first) sent = runtime.send("1", "question");
	});
	const runtime = runtimeFor(session, { remindSession });
	try {
		expect(await runtime.start(ROOT, "task", context).result).toMatchObject({
			status: "done",
			output: "task result",
			usage: { totalTokens: 12 },
		});
		await sent;
		expect(remindSession).toHaveBeenCalledTimes(2);
	} finally {
		await runtime.dispose();
	}
});

test("stopping a task's leftovers ends its children and stoppable work at once, naming what still ran", async () => {
	const job = Promise.withResolvers<void>();
	const stop = mock(() => {
		job.resolve();
		return true;
	});
	let stopped: string[] = [];
	const parent = sessionStub({
		prompt: async (text) => {
			if (text !== "task") return reply(parent, text);
			const child = runtime.start("1", "child task", context);
			runtime.trackCompletion("1", job.promise, {
				label: "PGID 42: job",
				stop,
			});
			// Work that already ended, though it is still settling, was not cut short.
			const ended = Promise.withResolvers<void>();
			runtime.trackCompletion("1", ended.promise, {
				label: "PGID 43: ended",
				stop: () => {
					ended.resolve();
					return false;
				},
			});
			stopped = runtime.stopLeftovers("1");
			expect(await child.result).toMatchObject({
				status: "aborted",
				leftover: true,
			});
			// The task goes on: it may start new work, then report.
			await runtime.start("1", "new child", context).result;
			reply(parent, "parent report");
		},
	});
	const runtime = runtimeWith({
		createSession: async (_context, { id }, onCreated) => {
			if (id === "1") return onCreated(parent);
			// A child that works until stopped, unless its work is new.
			const work = Promise.withResolvers<void>();
			const child = sessionStub({
				prompt: async (text) => {
					if (text === "new child") return reply(child, "new work");
					await work.promise;
				},
				abort: async () => work.resolve(),
			});
			onCreated(child);
		},
	});
	try {
		const result = await runtime.start(ROOT, "task", context).result;
		expect(result).toMatchObject({ status: "done", output: "parent report" });
		expect(result).not.toHaveProperty("leftover");
		expect(stopped).toEqual(["subagent 1.1", "PGID 42: job"]);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(runtime.get("1.2")?.status).toBe("done");
	} finally {
		await runtime.dispose();
	}
});

test("failed binding revokes a published session and retry creates a fresh one", async () => {
	const unsubscribe = mock(() => {});
	const failedPrompt = mock(async () => {
		throw new Error("disposed session was reused");
	});
	const failed = sessionStub({
		subscribe: () => unsubscribe,
		prompt: failedPrompt,
	});
	const good = sessionStub();
	const disposeSession = mock(async (_session: AgentSession) => {});
	let creates = 0;
	const runtime = runtimeFor(good, {
		createSession: async (_context, _owner, onCreated) => {
			const session = creates++ === 0 ? failed : good;
			onCreated(session);
			if (session === failed) throw new Error("binding failed");
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
	const runtime = runtimeWith({
		createSession: async (_context, _owner, onCreated) => {
			onCreated(sessionStub({ subscribe: () => unsubscribe }));
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
	const session = sessionStub({
		prompt: async () => gate.promise,
		abort: async () => {
			throw new Error("abort failed");
		},
	});
	const disposeSession = mock(async () => {});
	const runtime = runtimeFor(session, { disposeSession });
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
	let restarted: Promise<void> | undefined;
	const session = sessionStub({
		prompt: async (text: string) => {
			if (text === "restart") await gate.promise;
			reply(session, text);
		},
	});
	const runtime = runtimeFor(session);
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
	const first: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "first" }],
		details: { progress: 1 },
	};
	const final: AgentToolResult<unknown> = {
		content: [{ type: "text", text: "\u001b[31mraw tool output\u001b[0m" }],
		details: { complete: true },
	};
	let runs = 0;
	const session = sessionStub({
		subscribe: (handler) => {
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
					type: "tool_execution_start",
					toolCallId: "call/1",
					toolName: "nested",
					args: { nested: true },
					parentToolCallId: "call",
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "call/1",
					toolName: "nested",
					result: first,
					isError: true,
				});
				listener({
					type: "tool_execution_end",
					toolCallId: "call",
					toolName: "outer",
					result: final,
					isError: false,
				});
			} else expect(runtime.get("1")?.liveTools.size).toBe(0);
			reply(session, "done");
		},
	});
	const runtime = runtimeFor(session);
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
