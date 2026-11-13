import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	isProcessGroupActive,
	waitForGroupToFinish,
} from "../agent/process-groups.ts";
import {
	COMMAND_EXIT_TYPE,
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_RESUME_TYPE,
} from "../agent/protocol.ts";
import { ROOT, type Subagents } from "../runtime/index.ts";
import {
	backgroundJob,
	childExtension,
	deferred,
	lastCustomMessage,
	lastText,
	onCleanup,
	response,
	testRuntime as runtime,
	spawnContext,
	stream,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

const idle = (tree: Subagents) =>
	tree.get("1")?.session?.isIdle === true &&
	tree.get("1")?.session?.getLastAssistantText() !== undefined;

function exits(tree: Subagents) {
	return (
		tree
			.get("1")
			?.session?.messages.filter(
				(message) =>
					message.role === "custom" && message.customType === COMMAND_EXIT_TYPE,
			) ?? []
	);
}

function kill(pgid: number): void {
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

test.each([0, 1, -123, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])(
	"rejects unsafe process group %s",
	async (pgid) => {
		await expect(waitForGroupToFinish(pgid)).rejects.toThrow(
			"Invalid process group",
		);
	},
);

test("waits past shell exit for nohup and resolves when only zombies remain", async () => {
	const context = await spawnContext();
	const job = backgroundJob(context.cwd, "orphan");
	const child = spawn("bash", ["-c", job.command], {
		detached: true,
		stdio: "ignore",
	});
	const exited = once(child, "exit");
	const pgid = child.pid;
	if (!pgid) throw new Error("Missing child pid");
	onCleanup(() => kill(pgid));
	await exited;
	expect(await isProcessGroupActive(pgid)).toBe(true);
	let completed = false;
	const waiting = waitForGroupToFinish(pgid).then(() => {
		completed = true;
	});
	// Several polls, while the job outlives its shell.
	await Bun.sleep(150);
	expect(completed).toBe(false);
	await job.release();
	await waiting;
	expect(existsSync(job.finished)).toBe(true);
});

test("group waiting can be cancelled", async () => {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	const exited = once(child, "exit");
	const pgid = child.pid;
	if (!pgid) throw new Error("Missing child pid");
	onCleanup(async () => {
		kill(pgid);
		await exited;
	});
	const controller = new AbortController();
	const waiting = waitForGroupToFinish(pgid, controller.signal);
	controller.abort();
	await expect(waiting).rejects.toThrow();
});

test.each(["nohup", ""])(
	"%s background commands keep an idle agent running, including commands added while waiting",
	async (launcher) => {
		const tree = runtime();
		const context = await spawnContext(
			stream((ctx) => {
				const text = lastText(ctx);
				if (text === "first")
					return toolCall("bash", { command: first.command });
				if (text === "second")
					return toolCall("bash", { command: second.command });
				if (lastCustomMessage(ctx, COMMAND_EXIT_TYPE))
					return response("background checked");
				if (lastCustomMessage(ctx, SUBAGENT_RESUME_TYPE))
					return response("background checked, restated");
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
			output: "background checked, restated",
		});
		expect(existsSync(first.finished)).toBe(true);
		expect(existsSync(second.finished)).toBe(true);
		expect(exits(tree)).toHaveLength(2);
	},
);

test("command completion does not report a busy session's previous reply", async () => {
	const tree = runtime();
	const reply = deferred();
	const context = await spawnContext(
		stream(async (ctx, options) => {
			const text = lastText(ctx);
			if (text === "start") return toolCall("bash", { command: job.command });
			if (text === "still thinking")
				await Promise.race([reply.promise, waiting(options?.signal)]);
			if (lastCustomMessage(ctx, COMMAND_EXIT_TYPE))
				return response("verified after exit");
			if (lastCustomMessage(ctx, SUBAGENT_RESUME_TYPE))
				return response("verified after exit, restated");
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
		output: "verified after exit, restated",
	});
});

test.each(["abort", "dispose"] as const)(
	"%s kills nohup groups and cancellation permits reuse",
	async (action) => {
		const tree = runtime();
		const context = await spawnContext(
			stream((ctx) =>
				lastText(ctx) === "start"
					? toolCall("bash", { command: job.command })
					: response(lastText(ctx)),
			),
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
	"both commands and descendants must finish (%s finishes first)",
	async (first) => {
		const tree = runtime();
		const child = deferred();
		const context = await spawnContext(
			stream(async (ctx, options) => {
				const text = lastText(ctx);
				const last = ctx.messages.at(-1);
				if (text === "start") return toolCall("bash", { command: job.command });
				if (last?.role === "toolResult" && last.toolName === "bash")
					return toolCall("subagent", { instructions: "child work" });
				if (lastCustomMessage(ctx, COMMAND_EXIT_TYPE))
					return response("checked background");
				if (text === "child work") {
					await Promise.race([child.promise, waiting(options?.signal)]);
					return response("child finished");
				}
				return response(
					lastCustomMessage(ctx, SUBAGENT_RESULT_TYPE)
						? "final parent answer"
						: "waiting for all",
				);
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
					tree.get("1")?.session?.getLastAssistantText() ===
					"final parent answer",
			);
		}
		expect(tree.get("1")?.status).toBe("running");
		child.resolve();
		await job.release();
		expect(await started.result).toMatchObject({
			status: "done",
			output:
				first === "command" ? "final parent answer" : "checked background",
		});
	},
);

test("foreground-only commands do not notify or cause extra model calls", async () => {
	const tree = runtime();
	let requests = 0;
	const context = await spawnContext(
		stream((ctx) => {
			requests++;
			return lastText(ctx) === "start"
				? toolCall("bash", { command: "printf synchronous" })
				: response(lastText(ctx));
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
	const tree = runtime();
	let notifications = 0;
	const context = await spawnContext(
		stream((ctx) => {
			const text = lastText(ctx);
			if (text === "start") return toolCall("bash", { command: first.command });
			if (lastCustomMessage(ctx, COMMAND_EXIT_TYPE)) {
				notifications++;
				return notifications === 1
					? toolCall("bash", { command: second.command })
					: response("verified both jobs");
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

test("notification startup failures fail the run instead of delivering a stale final answer", async () => {
	const tree = runtime();
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
	spyOn(session, "sendCustomMessage").mockRejectedValue(
		new Error("wake failed"),
	);
	await job.release();
	expect(await started.result).toMatchObject({
		status: "error",
		error: "wake failed",
	});
});

test("configured bash overrides are not silently replaced with local execution", async () => {
	const tree = runtime();
	const context = await spawnContext(
		stream((ctx) =>
			lastText(ctx) === "start"
				? toolCall("bash", { command: "remote command" })
				: response(lastText(ctx)),
		),
	);
	await childExtension(
		context,
		"remote",
		`pi.registerTool({
			name: "bash", label: "Remote bash", description: "Remote execution",
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
			async execute() { return { content: [{ type: "text", text: "remote result" }], details: undefined }; }
		});`,
	);
	expect(await tree.start(ROOT, "start", context).result).toMatchObject({
		status: "done",
		output: "remote result",
	});
});

test("failed commands still wait for jobs they already started and retain shell configuration", async () => {
	const tree = runtime();
	const context = await spawnContext(
		stream((ctx) =>
			lastText(ctx) === "start"
				? toolCall("bash", {
						command: `${job.command}\nprintf '%s' "$PREFIX_VALUE"; exit 7`,
					})
				: response(
						lastCustomMessage(ctx, COMMAND_EXIT_TYPE)
							? "checked after shell failure"
							: lastText(ctx),
					),
		),
	);
	const job = backgroundJob(context.cwd, "failed");
	await writeFile(
		join(context.agentDir, "settings.json"),
		JSON.stringify({
			retry: { enabled: false },
			cacheWarming: "off",
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
	if (event?.role !== "custom") throw new Error("Missing command notification");
	expect(event.details).toMatchObject({ exitCode: null });
	expect(JSON.stringify(event.content)).not.toContain(
		"export PREFIX_VALUE=preserved",
	);
});
