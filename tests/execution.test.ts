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
	type Leftovers,
	ROOT,
	type SpawnContext,
	type SubagentsOptions,
} from "../runtime/index.ts";
import { deferred, model, onCleanup, response, until } from "./fixtures.ts";

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

/** A runtime shut down after the test, unless the test did so itself. */
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
		createSession: async (_context, _owner, onCreated) => onCreated(session),
		...options,
	});
}

/** The failures that a shutdown reports, in no particular order. */
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
		async (_context, _owner, onCreated) => onCreated(session),
	);
	const runtime = runtimeFor(session, { createSession, disposeSession });
	expect(createSession).not.toHaveBeenCalled();
	const result = await runtime.start(ROOT, "task instructions", context).result;
	// One session, created for the node from the context given.
	expect(createSession).toHaveBeenCalledTimes(1);
	expect(createSession.mock.calls[0]?.slice(0, 2)).toEqual([
		context,
		{ runtime, id: "1" },
	]);
	expect(prompt.mock.calls.map(([instructions]) => instructions)).toEqual([
		"task instructions",
	]);
	expect(result).toMatchObject({
		id: "1",
		status: "done",
		output: "complete output",
		usage: { totalTokens: 3 },
	});
	// Shutdowns requested together or again clean up once.
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
	await until(() => runtime.get("1")?.session !== undefined);
	expect(settled).toBe(false);
	finished.resolve();
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
			// Lands just before the microtask that resumes the run's drain.
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
			// The last message tells the parent what the agent was saying.
			expect(result.output).toContain("task result");
		}
		expect(remindSession).toHaveBeenCalledTimes(1);
		// A conversation the user continues is theirs: no report, no reminder.
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

test("a task's leftovers are its delegated children and its running work with a leftover handle, none of them stopped", async () => {
	const childWork = deferred();
	const job = deferred();
	const detach = mock(() => {});
	const running: Leftover = {
		label: "PGID 42: job",
		running: () => true,
		detach,
	};
	let found: Leftovers | undefined;
	const parent = sessionStub({
		prompt: async (text) => {
			if (text !== "task") return reply(parent, text);
			runtime.start("1", "child task", context);
			runtime.trackCompletion("1", job.promise, running);
			// Work that already ended, though it is still settling, is no leftover.
			runtime.trackCompletion("1", Promise.resolve(), {
				label: "PGID 43: ended",
				running: () => false,
				detach,
			});
			// Nor is work without a handle, e.g. a prompt.
			runtime.trackCompletion("1", job.promise);
			found = runtime.leftovers("1");
			reply(parent, "parent report");
			job.resolve();
			childWork.resolve();
		},
	});
	const runtime = runtimeWith({
		createSession: async (_context, { id }, onCreated) => {
			if (id === "1") return onCreated(parent);
			const child = sessionStub({
				prompt: async (text) => {
					await childWork.promise;
					reply(child, text);
				},
			});
			onCreated(child);
		},
	});
	expect(await runtime.start(ROOT, "task", context).result).toMatchObject({
		status: "done",
		output: "parent report",
	});
	expect(found?.children).toEqual(["1.1"]);
	expect(found?.work).toHaveLength(1);
	expect(found?.work[0]).toBe(running);
	expect(detach).not.toHaveBeenCalled();
	expect(runtime.get("1.1")?.status).toBe("done");
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
		createSession: async (_context, _owner, onCreated) => {
			onCreated(sessionStub({ subscribe: () => unsubscribe }));
		},
		disposeSession,
	});
	await runtime.start(ROOT, "one", context).result;
	await runtime.start(ROOT, "two", context).result;
	const errors = ["cleanup failed", "unsubscribe failed", "unsubscribe failed"];
	expect(await cleanupErrors(runtime.dispose())).toEqual(errors);
	// Shutting down again reports the same outcome, without repeating cleanup.
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
	/** What the outer call's snapshot showed as its events arrived. */
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
	// Cleared as the next run starts, not once it ends.
	expect(toolsInNextRun).toBe(0);
	expect(runtime.get("1")?.liveTools.size).toBe(0);
});
