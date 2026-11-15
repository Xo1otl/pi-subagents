import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	isProcessGroupActive,
	UNKNOWN_STATUS_REPORT_MS,
	waitForGroupToFinish,
} from "../agent/process-groups.ts";
import { COMMAND_EXIT_TYPE, COMMAND_UNKNOWN_TYPE } from "../agent/protocol.ts";
import { ROOT } from "../runtime/index.ts";
import {
	backgroundJob,
	customMessages,
	killGroup,
	lastCustomMessage,
	lastText,
	onCleanup,
	report,
	response,
	rootSession,
	spawnContext,
	stream,
	testRuntime,
	toolCall,
	until,
} from "./fixtures.ts";

const STATUS_ERROR = "Command failed: ps -A -o pgid=,stat=";

/** Count status checks of a group, failing the first `failures` of them, as
 * an overloaded `ps` did, until recovery.
 */
function statusChecks(pgid: () => number | undefined, failures: number) {
	const kill = process.kill.bind(process);
	let calls = 0;
	let failed = 0;
	let recovered = false;
	const spy = spyOn(process, "kill").mockImplementation((pid, signal) => {
		const target = pgid();
		if (signal === 0 && target && pid === -target) {
			calls++;
			if (!recovered && failed < failures) {
				failed++;
				throw new Error(STATUS_ERROR);
			}
		}
		return kill(pid, signal);
	});
	onCleanup(() => spy.mockRestore());
	return {
		calls: () => calls,
		failures: () => failed,
		recover: () => {
			recovered = true;
		},
	};
}

/** The group a job's shell recorded, once it has. */
function groupOf(job: ReturnType<typeof backgroundJob>) {
	return () =>
		existsSync(job.group) ? Number(readFileSync(job.group, "utf8")) : undefined;
}

/** Make the reporting delay pass, without waiting for it. */
function clock() {
	const now = performance.now.bind(performance);
	let skew = 0;
	const spy = spyOn(performance, "now").mockImplementation(() => now() + skew);
	onCleanup(() => spy.mockRestore());
	return {
		elapse: () => {
			skew += UNKNOWN_STATUS_REPORT_MS;
		},
	};
}

/** A detached group that runs until stopped. */
function sleeper() {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	const exited = once(child, "exit");
	const pgid = child.pid;
	if (!pgid) throw new Error("Missing child pid");
	const stop = () => {
		killGroup(pgid);
		return exited;
	};
	onCleanup(stop);
	return { pgid, stop };
}

test.each([0, 1, -123, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
	"rejects unsafe process group %p",
	async (pgid) => {
		await expect(waitForGroupToFinish(pgid)).rejects.toThrow(
			"Invalid process group",
		);
	},
);

test("waits past shell exit for nohup and resolves when only zombies remain", async () => {
	const context = await spawnContext();
	const job = backgroundJob(context.cwd, "orphan");
	const shell = spawn("bash", ["-c", job.command], {
		detached: true,
		stdio: "ignore",
	});
	const exited = once(shell, "exit");
	const pgid = shell.pid;
	if (!pgid) throw new Error("Missing shell pid");
	onCleanup(() => killGroup(pgid));
	await exited;
	// The job outlives its shell, and so does their group.
	expect(await isProcessGroupActive(pgid)).toBe(true);
	const waiting = waitForGroupToFinish(pgid);
	await job.release();
	await waiting;
	// The wait lasted until the job itself had finished.
	expect(existsSync(job.finished)).toBe(true);
});

test("group waiting can be cancelled", async () => {
	const { pgid } = sleeper();
	const controller = new AbortController();
	const waiting = waitForGroupToFinish(pgid, { signal: controller.signal });
	controller.abort();
	await expect(waiting).rejects.toThrow();
});

test("waiting outlasts transient status-check failures", async () => {
	const { pgid, stop } = sleeper();
	const checks = statusChecks(() => pgid, 2);
	let finished = false;
	const waiting = waitForGroupToFinish(pgid).then(() => {
		finished = true;
	});
	// Checks continue past the failures.
	await until(() => checks.calls() > 2);
	expect(finished).toBe(false);
	await stop();
	await waiting;
});

test("a status that stays unknown is told once, and watching continues", async () => {
	const time = clock();
	const { pgid } = sleeper();
	const checks = statusChecks(() => pgid, Number.POSITIVE_INFINITY);
	const told: unknown[] = [];
	const controller = new AbortController();
	const waiting = waitForGroupToFinish(pgid, {
		signal: controller.signal,
		onUnknown: (error) => {
			told.push(error);
		},
	});
	await until(() => checks.failures() >= 2);
	// Not before the status has stayed unknown for the reporting delay.
	expect(told).toHaveLength(0);
	time.elapse();
	await until(() => told.length === 1);
	expect(String(told[0])).toContain(STATUS_ERROR);
	// Checks keep failing, without further reports.
	const failures = checks.failures();
	await until(() => checks.failures() > failures);
	expect(told).toHaveLength(1);
	controller.abort();
	await expect(waiting).rejects.toThrow();
});

test("a failure to tell of an unknown status ends the wait", async () => {
	const time = clock();
	const { pgid } = sleeper();
	const checks = statusChecks(() => pgid, Number.POSITIVE_INFINITY);
	const waiting = waitForGroupToFinish(pgid, {
		onUnknown: () => {
			throw new Error("telling failed");
		},
	});
	await until(() => checks.failures() >= 2);
	time.elapse();
	await expect(waiting).rejects.toThrow("telling failed");
});

test.skipIf(process.platform !== "linux")(
	"process names cannot impersonate a finished state",
	async () => {
		const context = await spawnContext();
		// Read naively, this stat line has state Z.
		const script = join(context.cwd, "a) Z 1 2 (b");
		await writeFile(script, "#!/bin/sh\nread line\n");
		await chmod(script, 0o755);
		const child = spawn(script, [], {
			detached: true,
			stdio: ["pipe", "ignore", "ignore"],
		});
		const exited = once(child, "exit");
		const pgid = child.pid;
		if (!pgid) throw new Error("Missing child pid");
		onCleanup(() => child.stdin.end());
		await until(() =>
			readFileSync(`/proc/${pgid}/stat`, "utf8").includes("(b)"),
		);
		expect(await isProcessGroupActive(pgid)).toBe(true);
		child.stdin.end();
		await exited;
		expect(await isProcessGroupActive(pgid)).toBe(false);
	},
);

test("transient status-check failures neither stop a subagent's job nor lose its exit", async () => {
	const tree = testRuntime();
	const context = await spawnContext(
		stream((ctx) => {
			if (lastText(ctx) === "start")
				return toolCall("bash", { command: job.command });
			return lastCustomMessage(ctx, COMMAND_EXIT_TYPE)
				? report("checked after exit")
				: response("waiting");
		}),
	);
	const job = backgroundJob(context.cwd, "flaky");
	// Both the launch check and the watcher's first checks fail.
	const checks = statusChecks(groupOf(job), 3);
	const started = tree.start(ROOT, "start", context);
	await until(
		() =>
			checks.failures() === 3 &&
			tree.get("1")?.session?.getLastAssistantText() === "waiting",
	);
	expect(tree.get("1")?.status).toBe("running");
	expect(tree.get("1")?.error).toBeUndefined();
	await job.release();
	expect(await started.result).toMatchObject({
		status: "done",
		output: "checked after exit",
	});
	expect(existsSync(job.finished)).toBe(true);
	const messages = tree.get("1")?.session?.messages;
	expect(customMessages(messages, COMMAND_UNKNOWN_TYPE)).toHaveLength(0);
});

test("a subagent told its job's status stays unknown keeps the job and still learns of its exit", async () => {
	const time = clock();
	const tree = testRuntime();
	const context = await spawnContext(
		stream((ctx) => {
			if (lastText(ctx) === "start")
				return toolCall("bash", { command: job.command });
			if (lastCustomMessage(ctx, COMMAND_UNKNOWN_TYPE))
				return response("noted unknown");
			return lastCustomMessage(ctx, COMMAND_EXIT_TYPE)
				? report("checked after exit")
				: response("waiting");
		}),
	);
	const job = backgroundJob(context.cwd, "unknown");
	const checks = statusChecks(groupOf(job), Number.POSITIVE_INFINITY);
	const started = tree.start(ROOT, "start", context);
	// The launch check and the watcher's first check failed.
	await until(() => checks.failures() >= 2);
	time.elapse();
	const session = () => tree.get("1")?.session;
	await until(
		() =>
			session()?.isIdle === true &&
			session()?.getLastAssistantText() === "noted unknown",
	);
	const pgid = await job.pgid();
	expect(
		customMessages(session()?.messages, COMMAND_UNKNOWN_TYPE),
	).toMatchObject([{ details: { pgid, error: STATUS_ERROR } }]);
	expect(tree.get("1")?.status).toBe("running");
	expect(tree.get("1")?.error).toBeUndefined();
	checks.recover();
	expect(await isProcessGroupActive(pgid)).toBe(true);
	await job.release();
	expect(await started.result).toMatchObject({
		status: "done",
		output: "checked after exit",
	});
	expect(existsSync(job.finished)).toBe(true);
	expect(
		customMessages(session()?.messages, COMMAND_UNKNOWN_TYPE),
	).toHaveLength(1);
});

test("a parent told its job's status stays unknown still learns of its exit", async () => {
	const time = clock();
	let job: ReturnType<typeof backgroundJob> | undefined;
	const { session, tree } = await rootSession({
		streamFn: stream((context) => {
			if (lastText(context) === "start job" && job)
				return toolCall("bash", { command: job.command });
			if (lastCustomMessage(context, COMMAND_UNKNOWN_TYPE))
				return response("noted unknown");
			if (lastCustomMessage(context, COMMAND_EXIT_TYPE))
				return response("checked after exit");
			return response("job started");
		}),
	});
	job = backgroundJob(session.sessionManager.getCwd(), "parent-unknown");
	onCleanup(job.release);
	const checks = statusChecks(groupOf(job), Number.POSITIVE_INFINITY);
	await session.prompt("start job");
	await until(() => checks.failures() >= 2);
	time.elapse();
	await until(
		() => session.isIdle && session.getLastAssistantText() === "noted unknown",
	);
	checks.recover();
	await job.release();
	await until(
		() =>
			session.isIdle && session.getLastAssistantText() === "checked after exit",
	);
	await tree.settled(ROOT);
	expect(existsSync(job.finished)).toBe(true);
	expect(customMessages(session.messages, COMMAND_UNKNOWN_TYPE)).toHaveLength(
		1,
	);
	expect(customMessages(session.messages, COMMAND_EXIT_TYPE)).toHaveLength(1);
});
