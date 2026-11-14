import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	isProcessGroupActive,
	UNKNOWN_STATUS_REPORT_MS,
	waitForGroupToFinish,
} from "../agent/process-groups.ts";
import { COMMAND_EXIT_TYPE, COMMAND_UNKNOWN_TYPE } from "../agent/protocol.ts";
import { ROOT } from "../runtime/index.ts";
import {
	backgroundJob,
	lastCustomMessage,
	lastText,
	onCleanup,
	response,
	rootSession,
	testRuntime as runtime,
	spawnContext,
	stream,
	toolCall,
	until,
} from "./fixtures.ts";

const STATUS_ERROR = "Command failed: ps -A -o pgid=,stat=";

/** Fail status checks of a group, as an overloaded `ps` did, until recovery or
 * `count` failures.
 */
function failChecks(
	pgid: () => number | undefined,
	count = Number.POSITIVE_INFINITY,
) {
	const kill = process.kill.bind(process);
	let failures = 0;
	let recovered = false;
	const spy = spyOn(process, "kill").mockImplementation((pid, signal) => {
		const target = pgid();
		if (
			signal === 0 &&
			target &&
			pid === -target &&
			!recovered &&
			failures < count
		) {
			failures++;
			throw new Error(STATUS_ERROR);
		}
		return kill(pid, signal);
	});
	onCleanup(() => spy.mockRestore());
	return {
		failures: () => failures,
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

/** Make status that is already unknown look unknown for the reporting delay. */
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

function sleeper() {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	const exited = once(child, "exit");
	const pgid = child.pid;
	if (!pgid) throw new Error("Missing child pid");
	const stop = () => {
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {
			// Already gone.
		}
		return exited;
	};
	onCleanup(stop);
	return { pgid, stop };
}

function customMessages(
	messages: readonly AgentMessage[] | undefined,
	customType: string,
) {
	return (messages ?? []).filter(
		(message) => message.role === "custom" && message.customType === customType,
	);
}

test("waiting outlasts transient status-check failures", async () => {
	const { pgid, stop } = sleeper();
	const checks = failChecks(() => pgid, 3);
	let finished = false;
	const waiting = waitForGroupToFinish(pgid).then(() => {
		finished = true;
	});
	await until(() => checks.failures() === 3);
	// At least one successful check follows the failures.
	await Bun.sleep(1100);
	expect(finished).toBe(false);
	await stop();
	await waiting;
});

test("a status that stays unknown is told once, and watching continues", async () => {
	const { pgid, stop } = sleeper();
	const checks = failChecks(() => pgid);
	const told: unknown[] = [];
	let finished = false;
	const waiting = waitForGroupToFinish(
		pgid,
		undefined,
		(error) => {
			told.push(error);
		},
		250,
	).then(() => {
		finished = true;
	});
	await until(() => told.length === 1);
	// Checks keep failing, without further reports.
	const failures = checks.failures();
	await Bun.sleep(1100);
	expect(checks.failures()).toBeGreaterThan(failures);
	expect(told).toHaveLength(1);
	expect(String(told[0])).toContain(STATUS_ERROR);
	expect(finished).toBe(false);
	checks.recover();
	await stop();
	await waiting;
});

test("a failure to tell of an unknown status ends the wait", async () => {
	const { pgid } = sleeper();
	failChecks(() => pgid);
	await expect(
		waitForGroupToFinish(
			pgid,
			undefined,
			() => {
				throw new Error("telling failed");
			},
			0,
		),
	).rejects.toThrow("telling failed");
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
	const tree = runtime();
	const context = await spawnContext(
		stream((ctx) => {
			if (lastText(ctx) === "start")
				return toolCall("bash", { command: job.command });
			return response(
				lastCustomMessage(ctx, COMMAND_EXIT_TYPE)
					? "checked after exit"
					: "waiting",
			);
		}),
	);
	const job = backgroundJob(context.cwd, "flaky");
	// Both the launch check and the watcher's first checks fail.
	const checks = failChecks(groupOf(job), 3);
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
	const tree = runtime();
	const context = await spawnContext(
		stream((ctx) => {
			if (lastText(ctx) === "start")
				return toolCall("bash", { command: job.command });
			if (lastCustomMessage(ctx, COMMAND_UNKNOWN_TYPE))
				return response("noted unknown");
			return response(
				lastCustomMessage(ctx, COMMAND_EXIT_TYPE)
					? "checked after exit"
					: "waiting",
			);
		}),
	);
	const job = backgroundJob(context.cwd, "unknown");
	const checks = failChecks(groupOf(job));
	const started = tree.start(ROOT, "start", context);
	// The launch check and the watcher's first check failed.
	await until(() => checks.failures() >= 2);
	time.elapse();
	const node = () => tree.get("1");
	await until(
		() =>
			node()?.session?.isIdle === true &&
			node()?.session?.getLastAssistantText() === "noted unknown",
	);
	const pgid = await job.pgid();
	expect(
		customMessages(node()?.session?.messages, COMMAND_UNKNOWN_TYPE),
	).toMatchObject([{ details: { pgid, error: STATUS_ERROR } }]);
	expect(node()?.status).toBe("running");
	expect(node()?.error).toBeUndefined();
	checks.recover();
	expect(await isProcessGroupActive(pgid)).toBe(true);
	await job.release();
	expect(await started.result).toMatchObject({
		status: "done",
		output: "checked after exit",
	});
	expect(existsSync(job.finished)).toBe(true);
	expect(
		customMessages(node()?.session?.messages, COMMAND_UNKNOWN_TYPE),
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
	const checks = failChecks(groupOf(job));
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
