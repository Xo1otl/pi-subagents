import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { trackCommands } from "../agent/commands.ts";
import {
	type GroupWatch,
	isProcessGroupActive,
	liveProcessGroup,
	pollGroup,
	UNKNOWN_STATUS_REPORT_MS,
	waitForGroupToFinish,
} from "../agent/process-groups.ts";
import {
	COMMAND_EXIT_TYPE,
	COMMAND_UNKNOWN_TYPE,
	type CommandMessage,
} from "../agent/protocol.ts";
import {
	backgroundJob,
	killGroup,
	lastText,
	onCleanup,
	parentSession,
	response,
	spawnContext,
	stream,
	toolCall,
} from "./fixtures.ts";

async function pollSamples(
	samples: [at: number, active: boolean | Error][],
	onUnknown?: GroupWatch["onUnknown"],
) {
	let now = 0;
	const notices: { at: number; error: unknown }[] = [];
	await pollGroup(
		async () => {
			const sample = samples.shift();
			if (!sample) throw new Error("No more status samples");
			const [at, active] = sample;
			now = at;
			if (active instanceof Error) throw active;
			return active;
		},
		{
			onUnknown(error) {
				notices.push({ at: now, error });
				return onUnknown?.(error);
			},
		},
		{
			now: () => now,
			sleep: async () => {
				if (!samples.length) throw new Error("Polled past exit");
			},
		},
	);
	expect(samples).toHaveLength(0);
	return notices;
}

test("recovery resets the time spent unknown; transient failures are not exits", async () => {
	const limit = UNKNOWN_STATUS_REPORT_MS;
	const error = new Error("unreadable status");
	const notices = await pollSamples([
		[0, error],
		[limit - 1, true],
		[limit, error],
		[2 * limit - 1, error],
		[2 * limit, false],
	]);
	expect(notices).toEqual([]);
});

test("a sustained unknown status is reported once and watching continues until exit", async () => {
	const limit = UNKNOWN_STATUS_REPORT_MS;
	const first = new Error("unreadable status");
	const latest = new Error("still unreadable");
	const notices = await pollSamples([
		[0, true],
		[limit, first],
		[2 * limit - 1, first],
		[2 * limit, latest],
		[3 * limit, latest],
		[4 * limit, true],
		[5 * limit, first],
		[6 * limit, latest],
		[7 * limit, false],
	]);
	expect(notices).toEqual([{ error: latest, at: 2 * limit }]);
});

test("failure to deliver the unknown notice rejects the wait", async () => {
	const error = new Error("unreadable status");
	await expect(
		pollSamples(
			[
				[0, error],
				[UNKNOWN_STATUS_REPORT_MS, error],
			],
			async () => {
				throw new Error("telling failed");
			},
		),
	).rejects.toThrow("telling failed");
});

test("an unreadable group is tracked and its listener gets the unknown notice then the exit", async () => {
	const unreadable = new Error("status unavailable");
	const notices: CommandMessage[] = [];
	const completion = Promise.withResolvers<void>();
	const session = await parentSession({
		streamFn: stream((ctx) =>
			lastText(ctx) === "start"
				? toolCall("bash", { command: job.command })
				: response("waiting"),
		),
		extensions: [
			(pi) => {
				trackCommands(
					pi,
					{
						ownsJobs: true,
						track: (work) => completion.resolve(work),
						listener: () => (message) => {
							notices.push(message);
						},
					},
					{
						isActive: async () => {
							throw unreadable;
						},
						waitForExit: async (pgid, watch = {}) => {
							await watch.onUnknown?.(unreadable);
							await waitForGroupToFinish(pgid, watch);
						},
					},
				);
			},
		],
	});
	const job = backgroundJob(session.sessionManager.getCwd(), "unreadable");
	onCleanup(job.release);
	await session.prompt("start");
	const pgid = await job.pgid();
	expect(notices).toMatchObject([
		{
			customType: COMMAND_UNKNOWN_TYPE,
			details: { pgid, error: unreadable.message },
		},
	]);
	expect(await isProcessGroupActive(pgid)).toBe(true);
	await job.release();
	await completion.promise;
	expect(existsSync(job.finished)).toBe(true);
	expect(notices.map((message) => message.customType)).toEqual([
		COMMAND_UNKNOWN_TYPE,
		COMMAND_EXIT_TYPE,
	]);
});

test.each([0, 1, -123, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
	"rejects unsafe process group %p",
	async (pgid) => {
		await expect(waitForGroupToFinish(pgid)).rejects.toThrow(
			"Invalid process group",
		);
	},
);

test("waits past shell exit for nohup and can cancel a wait without ending the job", async () => {
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
	const controller = new AbortController();
	const cancelled = waitForGroupToFinish(pgid, { signal: controller.signal });
	controller.abort();
	await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
	expect(await isProcessGroupActive(pgid)).toBe(true);
	const waiting = waitForGroupToFinish(pgid);
	await job.release();
	await waiting;
	expect(existsSync(job.finished)).toBe(true);
});

test("Linux process names cannot impersonate a zombie state or a group ID", () => {
	const stat = (state: string) => `108 (a) Z 1 2 (b) ${state} 17 42 108 0`;
	expect(liveProcessGroup(stat("S"))).toBe(42);
	for (const state of ["Z", "X", "x"])
		expect(liveProcessGroup(stat(state))).toBeUndefined();
});
