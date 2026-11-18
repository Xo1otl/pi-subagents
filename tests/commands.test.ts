import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentText } from "@earendil-works/pi-ai";
import {
	isProcessGroupActive,
	waitForGroupToFinish,
} from "../agent/process-groups.ts";
import {
	COMMAND_EXIT_TYPE,
	SUBAGENT_REMINDER_TYPE,
	SUBAGENT_RESULT_TYPE,
} from "../agent/protocol.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import {
	answer,
	backgroundJob,
	childExtension,
	customMessages,
	deferred,
	hasCustomMessage,
	lastCustomMessage,
	lastText,
	remoteBash,
	report,
	response,
	spawnContext,
	stream,
	testRuntime,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

const idle = (tree: Subagents) =>
	tree.get("1")?.session?.isIdle === true &&
	tree.get("1")?.session?.getLastAssistantText() !== undefined;

const exits = (tree: Subagents) =>
	customMessages(tree.get("1")?.session?.messages, COMMAND_EXIT_TYPE);

test.each(["nohup", ""])(
	"%s background commands keep an idle agent running, including commands added while waiting",
	async (launcher) => {
		const tree = testRuntime();
		const context = await spawnContext(
			stream((ctx) => {
				const text = lastText(ctx);
				if (text === "first")
					return toolCall("bash", { command: first.command });
				if (text === "second")
					return toolCall("bash", { command: second.command });
				if (lastCustomMessage(ctx, COMMAND_EXIT_TYPE))
					return response("background checked");
				// Unreported once nothing is left to wait for, so reminded.
				if (lastCustomMessage(ctx, SUBAGENT_REMINDER_TYPE))
					return report("all background checked");
				return response(
					ctx.messages.at(-1)?.role === "toolResult" ? "latest reply" : text,
				);
			}),
		);
		const first = backgroundJob(context.cwd, "first", launcher);
		const second = backgroundJob(context.cwd, "second", launcher);
		const started = tree.start(ROOT, "first", context);
		await until(() => idle(tree));
		expect(tree.get("1")?.status).toBe("running");
		await tree.send("1", "second");
		expect(tree.get("1")?.status).toBe("running");
		await first.release();
		await waitForGroupToFinish(await first.pgid());
		await until(() => exits(tree).length === 1 && idle(tree));
		expect(tree.get("1")?.status).toBe("running");
		await tree.send("1", "last assistant reply");
		await second.release();
		expect(await started.result).toMatchObject({
			status: "done",
			output: "all background checked",
		});
		expect(existsSync(first.finished)).toBe(true);
		expect(existsSync(second.finished)).toBe(true);
		expect(exits(tree)).toHaveLength(2);
		// The launch result names the group, so its exit notice can stay short:
		// one bounded line, while details keep the full command.
		const pgid = String(await first.pgid());
		const launch = tree
			.get("1")
			?.session?.messages.find(
				(message) =>
					message.role === "toolResult" && message.toolName === "bash",
			);
		if (launch?.role !== "toolResult") throw new Error("Missing launch");
		expect(contentText(launch.content)).toContain(pgid);
		const exit = exits(tree)[0];
		if (!exit) throw new Error("Missing exit");
		const notice = contentText(exit.content);
		expect(notice).toContain(pgid);
		expect(notice).not.toContain("\n");
		expect(notice.length).toBeLessThan(first.command.length);
		expect(exit.details).toMatchObject({ command: first.command });
	},
);

test("a job exit reaching a busy session is answered after its reply", async () => {
	const tree = testRuntime();
	const reply = deferred();
	const context = await spawnContext(
		stream(async (ctx, options) => {
			const text = lastText(ctx);
			if (text === "start") return toolCall("bash", { command: job.command });
			if (text === "still thinking")
				await Promise.race([reply.promise, waiting(options?.signal)]);
			if (lastCustomMessage(ctx, COMMAND_EXIT_TYPE))
				return report("verified after exit");
			return response(text);
		}),
	);
	const job = backgroundJob(context.cwd, "busy");
	const started = tree.start(ROOT, "start", context);
	await until(() => idle(tree));
	const sent = tree.send("1", "still thinking");
	await until(() => tree.get("1")?.session?.isIdle === false);
	await job.release();
	await waitForGroupToFinish(await job.pgid());
	await until(() => tree.get("1")?.session?.agent.hasQueuedMessages() === true);
	expect(tree.get("1")?.status).toBe("running");
	reply.resolve();
	await sent;
	expect(await started.result).toMatchObject({
		status: "done",
		output: "verified after exit",
	});
});

test.each(["abort", "dispose"] as const)(
	"%s kills nohup groups and cancellation permits reuse",
	async (action) => {
		const tree = testRuntime();
		const context = await spawnContext(
			stream((ctx) => {
				if (lastText(ctx) === "start")
					return toolCall("bash", { command: job.command });
				if (ctx.messages.at(-1)?.role === "toolResult")
					return response("waiting for the job");
				return answer(ctx, lastText(ctx));
			}),
		);
		const job = backgroundJob(context.cwd, "stop");
		const started = tree.start(ROOT, "start", context);
		await until(() => idle(tree));
		const pgid = await job.pgid();
		if (action === "abort") tree.abort("1");
		else await tree.dispose();
		expect((await started.result).status).toBe("aborted");
		await waitForGroupToFinish(pgid);
		expect(existsSync(job.finished)).toBe(false);
		if (action === "abort") {
			const sibling = tree.start(ROOT, "sibling", context);
			expect((await sibling.result).output).toBe("sibling");
			await tree.send("1", "restarted");
			expect(tree.get("1")?.status).toBe("done");
			expect(exits(tree)).toHaveLength(0);
		}
	},
);

test.each(["command", "child"] as const)(
	"an unreported task waits for both commands and descendants (%s finishes first)",
	async (first) => {
		const tree = testRuntime();
		const child = deferred();
		const context = await spawnContext(
			stream(async (ctx, options) => {
				const text = lastText(ctx);
				const last = ctx.messages.at(-1);
				if (text === "start") return toolCall("bash", { command: job.command });
				if (last?.role === "toolResult" && last.toolName === "bash")
					return toolCall("subagent", { instructions: "child work" });
				if (text === "child work") {
					await Promise.race([child.promise, waiting(options?.signal)]);
					return report("child finished");
				}
				// Reports once it has heard of both.
				return hasCustomMessage(ctx, COMMAND_EXIT_TYPE) &&
					hasCustomMessage(ctx, SUBAGENT_RESULT_TYPE)
					? report("final parent answer")
					: response("waiting for all");
			}),
		);
		const job = backgroundJob(context.cwd, "nested");
		const started = tree.start(ROOT, "start", context);
		await until(() => idle(tree) && tree.get("1.1")?.session?.isIdle === false);
		if (first === "command") {
			await job.release();
			await waitForGroupToFinish(await job.pgid());
			await until(() => exits(tree).length === 1 && idle(tree));
		} else {
			child.resolve();
			await until(
				() =>
					customMessages(tree.get("1")?.session?.messages, SUBAGENT_RESULT_TYPE)
						.length === 1 &&
					tree.get("1")?.session?.getLastAssistantText() === "waiting for all",
			);
		}
		expect(tree.get("1")?.status).toBe("running");
		child.resolve();
		await job.release();
		expect(await started.result).toMatchObject({
			status: "done",
			output: "final parent answer",
		});
	},
);

test("foreground-only commands do not notify or cause extra model calls", async () => {
	const tree = testRuntime();
	let requests = 0;
	const context = await spawnContext(
		stream((ctx) => {
			requests++;
			return lastText(ctx) === "start"
				? toolCall("bash", { command: "printf synchronous" })
				: answer(ctx, lastText(ctx));
		}),
	);
	expect(await tree.start(ROOT, "start", context).result).toMatchObject({
		status: "done",
		output: "synchronous",
	});
	expect(requests).toBe(2);
	expect(exits(tree)).toHaveLength(0);
});

test("a command-exit wake can launch another background command before reporting to its parent", async () => {
	const tree = testRuntime();
	let notifications = 0;
	const context = await spawnContext(
		stream((ctx) => {
			const text = lastText(ctx);
			if (text === "start") return toolCall("bash", { command: first.command });
			if (lastCustomMessage(ctx, COMMAND_EXIT_TYPE)) {
				notifications++;
				return notifications === 1
					? toolCall("bash", { command: second.command })
					: report("verified both jobs");
			}
			return response("work remains");
		}),
	);
	const first = backgroundJob(context.cwd, "wake-first");
	const second = backgroundJob(context.cwd, "wake-second");
	const started = tree.start(ROOT, "start", context);
	await until(() => idle(tree));
	await first.release();
	await until(() => existsSync(second.group) && idle(tree));
	expect(tree.get("1")?.status).toBe("running");
	expect(notifications).toBe(1);
	await second.release();
	expect(await started.result).toMatchObject({
		status: "done",
		output: "verified both jobs",
	});
	expect(notifications).toBe(2);
});

test.each(["waits for the exit", "reports again"] as const)(
	"a report while a job runs is refused, naming the job; the agent %s",
	async (choice) => {
		const tree = testRuntime();
		let refusal = "";
		let requests = 0;
		const context = await spawnContext(
			stream((ctx) => {
				requests++;
				const last = ctx.messages.at(-1);
				if (lastText(ctx) === "start")
					return toolCall("bash", { command: job.command });
				if (last?.role === "toolResult" && last.toolName === "bash")
					return report("first report");
				if (lastCustomMessage(ctx, COMMAND_EXIT_TYPE))
					return report("report after exit");
				refusal = lastText(ctx);
				return choice === "reports again"
					? report("report leaving the job")
					: response("waiting for the job");
			}),
		);
		const job = backgroundJob(context.cwd, "refused");
		const started = tree.start(ROOT, "start", context);
		if (choice === "waits for the exit") {
			// The refused report was not sent, and the job is still tracked.
			await until(() => idle(tree));
			expect(tree.get("1")?.status).toBe("running");
			await job.release();
			expect(await started.result).toMatchObject({
				status: "done",
				output: "report after exit",
			});
			expect(exits(tree)).toHaveLength(1);
			expect(requests).toBe(4);
		} else {
			// Sent while the job runs, which then ends the turn.
			expect(await started.result).toMatchObject({
				status: "done",
				output: "report leaving the job",
			});
			expect(requests).toBe(3);
			// Untracked, it is not stopped at shutdown either.
			await tree.dispose();
			expect(await isProcessGroupActive(await job.pgid())).toBe(true);
			await job.release();
			await waitForGroupToFinish(await job.pgid());
			expect(existsSync(job.finished)).toBe(true);
		}
		expect(refusal).toContain(String(await job.pgid()));
	},
);

test("a job started after a refusal refuses the next report too", async () => {
	const tree = testRuntime();
	const refusals: string[] = [];
	const context = await spawnContext(
		stream((ctx) => {
			const last = ctx.messages.at(-1);
			if (lastText(ctx) === "start")
				return toolCall("bash", { command: first.command });
			if (last?.role !== "toolResult") return response("unexpected");
			if (last.toolName === "bash") return report("report");
			refusals.push(lastText(ctx));
			return refusals.length === 1
				? toolCall("bash", { command: second.command })
				: report("report leaving both jobs");
		}),
	);
	const first = backgroundJob(context.cwd, "told");
	const second = backgroundJob(context.cwd, "untold");
	expect(await tree.start(ROOT, "start", context).result).toMatchObject({
		status: "done",
		output: "report leaving both jobs",
	});
	expect(refusals).toHaveLength(2);
	expect(refusals[1]).toContain(String(await second.pgid()));
	for (const job of [first, second])
		expect(await isProcessGroupActive(await job.pgid())).toBe(true);
	await first.release();
	await second.release();
});

test("a report with nothing left running ends the turn at once", async () => {
	const tree = testRuntime();
	let requests = 0;
	const context = await spawnContext(
		stream(() => {
			requests++;
			return report("done at once");
		}),
	);
	expect(await tree.start(ROOT, "start", context).result).toMatchObject({
		status: "done",
		output: "done at once",
	});
	expect(requests).toBe(1);
	// No turn follows the report's own result.
	expect(tree.get("1")?.session?.messages.at(-1)).toMatchObject({
		role: "toolResult",
		isError: false,
	});
});

test("a report waits for messages already queued, and a later report replaces it", async () => {
	const tree = testRuntime();
	const reply = deferred();
	const context = await spawnContext(
		stream(async (ctx, options) => {
			if (lastText(ctx) === "start")
				return toolCall("bash", { command: job.command });
			if (lastCustomMessage(ctx, COMMAND_EXIT_TYPE))
				return report("revised after exit");
			if (lastText(ctx) === "report now") {
				await Promise.race([reply.promise, waiting(options?.signal)]);
				return report("first report");
			}
			return response("waiting");
		}),
	);
	const job = backgroundJob(context.cwd, "queued");
	const started = tree.start(ROOT, "start", context);
	await until(() => idle(tree));
	const sent = tree.send("1", "report now");
	await until(() => tree.get("1")?.session?.isIdle === false);
	await job.release();
	await waitForGroupToFinish(await job.pgid());
	await until(() => tree.get("1")?.session?.agent.hasQueuedMessages() === true);
	reply.resolve();
	await sent;
	expect(await started.result).toMatchObject({
		status: "done",
		output: "revised after exit",
	});
});

test("notification startup failures fail the run instead of delivering a stale final answer", async () => {
	const tree = testRuntime();
	const context = await spawnContext(
		stream((ctx) =>
			lastText(ctx) === "start"
				? toolCall("bash", { command: job.command })
				: response("old answer"),
		),
	);
	const job = backgroundJob(context.cwd, "notification-error");
	const started = tree.start(ROOT, "start", context);
	await until(() => idle(tree));
	const session = tree.get("1")?.session;
	if (!session) throw new Error("Missing child session");
	// Only the exit notice fails: a reminder would otherwise fail the run too.
	const send = session.sendCustomMessage.bind(session);
	spyOn(session, "sendCustomMessage").mockImplementation((message, options) =>
		message.customType === COMMAND_EXIT_TYPE
			? Promise.reject(new Error("wake failed"))
			: send(message, options),
	);
	await job.release();
	expect(await started.result).toMatchObject({
		status: "error",
		error: "wake failed",
	});
});

test("configured bash overrides are not silently replaced with local execution", async () => {
	const tree = testRuntime();
	const context = await spawnContext(
		stream((ctx) =>
			lastText(ctx) === "start"
				? toolCall("bash", { command: "remote command" })
				: answer(ctx, lastText(ctx)),
		),
	);
	await childExtension(context, "remote", remoteBash);
	expect(await tree.start(ROOT, "start", context).result).toMatchObject({
		status: "done",
		output: "remote result",
	});
});

test("failed commands still wait for jobs they already started and retain shell configuration", async () => {
	const tree = testRuntime();
	const context = await spawnContext(
		stream((ctx) =>
			lastText(ctx) === "start"
				? toolCall("bash", {
						command: `${job.command}\nprintf '%s' "$PREFIX_VALUE"; exit 7`,
					})
				: lastCustomMessage(ctx, COMMAND_EXIT_TYPE)
					? report("checked after shell failure")
					: response(lastText(ctx)),
		),
	);
	const job = backgroundJob(context.cwd, "failed");
	const settingsPath = join(context.agentDir, "settings.json");
	await writeFile(
		settingsPath,
		JSON.stringify({
			...JSON.parse(await readFile(settingsPath, "utf8")),
			shellPath: "/bin/bash",
			shellCommandPrefix: "export PREFIX_VALUE=preserved",
		}),
	);
	const started = tree.start(ROOT, "start", context);
	await until(() => idle(tree));
	expect(tree.get("1")?.session?.getLastAssistantText()).toContain("preserved");
	expect(tree.get("1")?.status).toBe("running");
	await job.release();
	expect((await started.result).output).toBe("checked after shell failure");
	const event = exits(tree)[0];
	if (!event) throw new Error("Missing command notification");
	expect(event.details).toMatchObject({ exitCode: null });
	expect(JSON.stringify(event.content)).not.toContain(
		"export PREFIX_VALUE=preserved",
	);
});

test("a long foreground sleep is refused before it runs", async () => {
	const tree = testRuntime();
	const context = await spawnContext(
		stream((ctx) => {
			const last = ctx.messages.at(-1);
			// Wording is not under test: only that the call failed without running.
			return last?.role === "toolResult"
				? answer(ctx, `isError: ${last.isError}`)
				: toolCall("bash", { command: `cd . && sleep 90; touch ${marker}` });
		}),
	);
	const marker = join(context.cwd, "slept");
	expect(await tree.start(ROOT, "start", context).result).toMatchObject({
		status: "done",
		output: "isError: true",
	});
	expect(existsSync(marker)).toBe(false);
});
