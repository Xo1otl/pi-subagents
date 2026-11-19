import { expect, mock, spyOn, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type AgentSession,
	type AgentSessionEvent,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { errorMessage } from "../runtime/errors.ts";
import {
	createSubagents,
	type Leftover,
	ROOT,
	type SpawnContext,
	type SubagentsOptions,
} from "../runtime/index.ts";
import {
	checkpoint,
	deferred,
	model,
	onCleanup,
	response,
	until,
} from "./fixtures.ts";

const context: SpawnContext = { cwd: "/unused", model, projectTrusted: false };

const REPORT = "test-report";

function reportOf(entry: SessionEntry): string | undefined {
	return entry.type === "custom" && entry.customType === REPORT
		? String(entry.data)
		: undefined;
}

function reply(session: AgentSession, text: string, reported = true): void {
	session.sessionManager.appendMessage(response(text));
	if (reported) session.sessionManager.appendCustomEntry(REPORT, text);
}

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
	const runtime = createSubagents({
		remindSession: async () => {},
		disposeSession: async () => {},
		reportOf,
		...options,
	});
	onCleanup(() => (runtime.closed ? undefined : runtime.dispose()));
	return runtime;
}

function runtimeFor(
	session: AgentSession,
	options: Partial<SubagentsOptions> = {},
) {
	return runtimeWith({
		createSession: async ({ onCreated }) => onCreated(session),
		...options,
	});
}

async function cleanupErrors(closing: Promise<void>): Promise<string[]> {
	const failure = await closing.then(
		() => undefined,
		(error: unknown) => error,
	);
	if (!(failure instanceof AggregateError))
		throw new Error("Shutdown reported no cleanup errors");
	return failure.errors.map(errorMessage).toSorted();
}

test("runtime owns execution but delegates session creation and disposal", async () => {
	const unsubscribe = mock(() => {});
	const prompt = mock(async (_instructions: string) => {
		reply(session, "complete output");
	});
	const session = sessionStub({ subscribe: () => unsubscribe, prompt });
	const disposeSession = mock(async (_session: AgentSession) => {});
	const createSession = mock<SubagentsOptions["createSession"]>(
		async ({ onCreated }) => onCreated(session),
	);
	const runtime = runtimeFor(session, { createSession, disposeSession });
	expect(createSession).not.toHaveBeenCalled();
	const result = await runtime.start(ROOT, "task instructions", context).result;
	expect(createSession).toHaveBeenCalledTimes(1);
	expect(createSession.mock.calls[0]?.[0]).toMatchObject({
		context,
		owner: { runtime, id: "1" },
	});
	expect(prompt.mock.calls.map(([instructions]) => instructions)).toEqual([
		"task instructions",
	]);
	expect(result).toMatchObject({
		id: "1",
		status: "done",
		output: "complete output",
		usage: { totalTokens: 3 },
	});
	await Promise.all([runtime.dispose(), runtime.dispose()]);
	await runtime.dispose();
	expect(disposeSession.mock.calls).toEqual([[session]]);
	expect(unsubscribe).toHaveBeenCalledTimes(1);
});

test("ledger write failures do not leave completed runs stuck running or prevent reuse", async () => {
	const rootSessionManager = SessionManager.inMemory();
	const ledger = spyOn(rootSessionManager, "appendUsage").mockImplementation(
		() => {
			throw new Error("ledger unavailable");
		},
	);
	const runtime = runtimeFor(sessionStub(), { rootSessionManager });
	await expect(runtime.start(ROOT, "initial", context).result).rejects.toThrow(
		"ledger unavailable",
	);
	expect(runtime.get("1")?.status).toBe("done");
	ledger.mockRestore();
	await runtime.send("1", "resume");
	expect(runtime.get("1")?.status).toBe("done");
	expect(rootSessionManager.getEntries()).toHaveLength(1);
});

test("start reserves a running receipt synchronously, before session initialization", async () => {
	const initialization = checkpoint();
	const prompt = checkpoint();
	const session = sessionStub({
		prompt: async () => {
			await prompt.pass();
			reply(session, "child finished");
		},
	});
	const createSession = mock<SubagentsOptions["createSession"]>(
		async ({ onCreated }) => {
			await initialization.pass();
			onCreated(session);
		},
	);
	const runtime = runtimeFor(session, { createSession });
	const started = runtime.start(ROOT, "delayed child", context);
	expect(started.id).toBe("1");
	expect(createSession).not.toHaveBeenCalled();
	expect(runtime.get("1")?.status).toBe("running");
	expect(runtime.get("1")?.session).toBeUndefined();
	await initialization.reached;
	expect(createSession).toHaveBeenCalledTimes(1);
	expect(Bun.peek.status(started.result)).toBe("pending");
	initialization.open();
	await prompt.reached;
	expect(runtime.get("1")?.session).toBe(session);
	expect(Bun.peek.status(started.result)).toBe("pending");
	prompt.open();
	expect(await started.result).toMatchObject({
		status: "done",
		output: "child finished",
	});
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
	const initialization = checkpoint();
	const prompt = mock(async () => {});
	const session = sessionStub({ prompt });
	const disposeSession = mock(async () => {});
	const runtime = runtimeFor(session, {
		createSession: async ({ onCreated }) => {
			await initialization.pass();
			onCreated(session);
		},
		disposeSession,
	});
	const started = runtime.start(ROOT, "hello", context);
	await initialization.reached;
	runtime.abort("1");
	const closing = runtime.dispose();
	initialization.open();
	expect((await started.result).status).toBe("aborted");
	await closing;
	expect(prompt).not.toHaveBeenCalled();
	expect(disposeSession).toHaveBeenCalledTimes(1);
});

test("initialization failures are run data, and orphaned completion failures are reported once at shutdown", async () => {
	const disposeSession = mock(async (_session: AgentSession) => {});
	const runtime = runtimeWith({
		createSession: async () => {
			throw new Error("session unavailable");
		},
		disposeSession,
	});
	const { result } = runtime.start(ROOT, "task", context);
	const delivery = Promise.reject(new Error("delivery failed"));
	runtime.trackCompletion(ROOT, delivery);
	runtime.trackCompletion(ROOT, delivery);
	expect(await result).toMatchObject({
		status: "error",
		error: "session unavailable",
		output: "session unavailable",
	});
	expect(await cleanupErrors(runtime.dispose())).toEqual(["delivery failed"]);
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
	expect(await runtime.start(ROOT, "task", context).result).toMatchObject({
		status: "error",
		error: "delivery failed",
		usage: { totalTokens: 3 },
	});
});

test("a send arriving as the run's last work settles is drained and billed", async () => {
	let sent: Promise<void> | undefined;
	const session = sessionStub({
		prompt: async (text) => {
			reply(session, text);
			if (text === "initial")
				queueMicrotask(() => {
					sent = runtime.send("1", "late input");
				});
		},
	});
	const runtime = runtimeFor(session);
	expect(await runtime.start(ROOT, "initial", context).result).toMatchObject({
		output: "late input",
		usage: { totalTokens: 6 },
	});
	await sent;
});

test.each([true, false])(
	"an idle task with nothing left to wait for is reminded once to report (reports when reminded: %p)",
	async (heard) => {
		const session = sessionStub({
			prompt: async (text) => reply(session, `re: ${text}`, false),
		});
		const remindSession = mock(async (reminded: AgentSession) => {
			reply(reminded, "task result", heard);
		});
		const runtime = runtimeFor(session, { remindSession });
		const result = await runtime.start(ROOT, "task", context).result;
		if (heard)
			expect(result).toMatchObject({ status: "done", output: "task result" });
		else {
			expect(result).toMatchObject({
				status: "error",
				error: expect.any(String),
			});
			expect(result.output).toContain("task result");
		}
		expect(remindSession).toHaveBeenCalledTimes(1);
		await runtime.send("1", "continue");
		expect(runtime.get("1")?.status).toBe("done");
		expect(remindSession).toHaveBeenCalledTimes(1);
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
	expect(await runtime.start(ROOT, "task", context).result).toMatchObject({
		status: "done",
		output: "task result",
		usage: { totalTokens: 12 },
	});
	await sent;
	expect(remindSession).toHaveBeenCalledTimes(2);
});

test("leftovers list only the owner's delegated children and running jobs", async () => {
	const runtime = runtimeWith({
		createSession: async ({ onCreated }) => onCreated(sessionStub()),
	});
	const parent = runtime.start(ROOT, "parent task", context);
	const child = runtime.start(parent.id, "child task", context);
	const job = deferred();
	const running: Leftover = {
		label: "PGID 42: job",
		running: () => true,
		detach: mock(() => {}),
	};
	runtime.trackCompletion(parent.id, job.promise, running);
	runtime.trackCompletion(parent.id, job.promise);
	runtime.trackCompletion(ROOT, job.promise);
	runtime.trackCompletion(parent.id, Promise.resolve(), {
		...running,
		running: () => false,
	});

	expect(runtime.leftovers(parent.id)).toEqual({
		children: [child.id],
		work: [running],
	});
	expect(runtime.leftovers(ROOT).work).toEqual([]);
	job.resolve();
	await parent.result;
	expect(runtime.get(child.id)?.status).toBe("done");
	expect(runtime.leftovers(parent.id)).toEqual({ children: [], work: [] });
	expect(running.detach).not.toHaveBeenCalled();
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
		createSession: async ({ onCreated }) => {
			const session = creates++ === 0 ? failed : good;
			onCreated(session);
			if (session === failed) throw new Error("binding failed");
		},
		disposeSession,
	});
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
	await runtime.dispose();
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
		createSession: async ({ onCreated }) => {
			onCreated(sessionStub({ subscribe: () => unsubscribe }));
		},
		disposeSession,
	});
	await runtime.start(ROOT, "one", context).result;
	await runtime.start(ROOT, "two", context).result;
	const errors = ["cleanup failed", "unsubscribe failed", "unsubscribe failed"];
	expect(await cleanupErrors(runtime.dispose())).toEqual(errors);
	expect(await cleanupErrors(runtime.dispose())).toEqual(errors);
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
	await until(() => runtime.get("1")?.session !== undefined);
	runtime.abort("1");
	gate.resolve();
	expect((await started.result).status).toBe("aborted");
	expect(await cleanupErrors(runtime.dispose())).toEqual(["abort failed"]);
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
	expect((await runtime.start(ROOT, "initial", context).result).output).toBe(
		"initial",
	);
	expect(restarted).toBeDefined();
	expect(runtime.get("1")?.status).toBe("running");
	gate.resolve();
	await restarted;
	expect(runtime.get("1")?.status).toBe("done");
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
	const outer = () => runtime.get("1")?.liveTools.get("call");
	const seen: unknown[] = [];
	let toolsInNextRun: number | undefined;
	let runs = 0;
	const session = sessionStub({
		subscribe: (handler) => {
			listener = handler;
			return () => {};
		},
		prompt: async () => {
			if (runs++ > 0) {
				toolsInNextRun = runtime.get("1")?.liveTools.size;
				return reply(session, "done");
			}
			listener({
				type: "tool_execution_start",
				toolCallId: "call",
				toolName: "outer",
				args: { value: 1 },
			});
			seen.push(outer()?.status);
			listener({
				type: "tool_execution_update",
				toolCallId: "call",
				toolName: "outer",
				args: { value: 1 },
				partialResult: first,
			});
			seen.push(outer()?.result);
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
			reply(session, "done");
		},
	});
	const runtime = runtimeFor(session);
	expect((await runtime.start(ROOT, "tools", context).result).status).toBe(
		"done",
	);
	expect(seen).toEqual(["running", first]);
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
	expect(toolsInNextRun).toBe(0);
	expect(runtime.get("1")?.liveTools.size).toBe(0);
});
