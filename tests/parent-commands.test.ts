import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type {
	AgentSession,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
	isProcessGroupActive,
	waitForGroupToFinish,
} from "../agent/process-groups.ts";
import { COMMAND_EXIT_TYPE } from "../agent/protocol.ts";
import { ROOT } from "../runtime/index.ts";
import {
	backgroundJob,
	customMessages,
	deferred,
	lastCustomMessage,
	lastText,
	onCleanup,
	remoteBash,
	response,
	rootSession,
	stream,
	toolCall,
	until,
	waiting,
} from "./fixtures.ts";

/** A root that starts `job` when told to, with the rest of its replies given. */
async function setup(
	reply: (
		context: TranscriptContext,
		signal?: AbortSignal,
	) => string | Promise<string>,
	extensions?: ExtensionFactory[],
) {
	let job: ReturnType<typeof backgroundJob> | undefined;
	const { session, tree } = await rootSession({
		extensions,
		streamFn: stream(async (context, options) => {
			if (lastText(context) === "start job") {
				if (!job) throw new Error("Missing job");
				return toolCall("bash", { command: job.command });
			}
			return response(
				context.messages.at(-1)?.role === "toolResult"
					? "job started"
					: await reply(context, options?.signal),
			);
		}),
	});
	job = backgroundJob(session.sessionManager.getCwd(), "parent");
	// The root never ends its jobs, so the tests must.
	onCleanup(job.release);
	return { session, tree, job };
}

const exits = (session: AgentSession) =>
	customMessages(session.messages, COMMAND_EXIT_TYPE);

const checked = (context: TranscriptContext) =>
	lastCustomMessage(context, COMMAND_EXIT_TYPE)
		? "checked after exit"
		: lastText(context);

test("a parent's background job resumes it when idle, and private user commands stay untracked", async () => {
	const { session, tree, job } = await setup(checked);
	const userBash = (excludeFromContext: boolean) =>
		session.extensionRunner.emitUserBash({
			type: "user_bash",
			command: "true",
			excludeFromContext,
			cwd: session.sessionManager.getCwd(),
		});
	expect((await userBash(false))?.operations).toBeDefined();
	expect(await userBash(true)).toBeUndefined();

	await session.prompt("start job");
	expect(session.getLastAssistantText()).toBe("job started");
	await session.prompt("still available");
	expect(exits(session)).toHaveLength(0);
	await job.release();
	await until(
		() =>
			session.isIdle && session.getLastAssistantText() === "checked after exit",
	);
	await tree.settled(ROOT);
	expect(existsSync(job.finished)).toBe(true);
	expect(exits(session)).toHaveLength(1);
	expect(exits(session)[0]).toMatchObject({
		details: { pgid: await job.pgid(), exitCode: null },
	});
});

test("a job exit waits for a busy parent, survives its interrupt, and does not restart the turn", async () => {
	const busy = deferred();
	let running = false;
	let notified = 0;
	const { session, tree, job } = await setup(async (context, signal) => {
		const text = lastText(context);
		if (text === "busy prompt") {
			running = true;
			await Promise.race([busy.promise, waiting(signal)]);
		}
		if (lastCustomMessage(context, COMMAND_EXIT_TYPE)) notified++;
		return checked(context);
	});
	await session.prompt("start job");
	const prompt = session.prompt("busy prompt");
	await until(() => running);
	await job.release();
	await waitForGroupToFinish(await job.pgid());
	await tree.settled(ROOT);
	// Held by the integration, so an interrupt clearing pi's queue cannot drop it.
	expect(session.agent.hasQueuedMessages()).toBe(false);
	expect(exits(session)).toHaveLength(0);
	session.clearQueue();
	await session.abort();
	await prompt;
	await session.waitForIdle();
	expect(exits(session)).toHaveLength(1);
	expect(notified).toBe(0);
});

test("shutdown stops watching a parent's job without ending it", async () => {
	const { session, tree, job } = await setup(checked);
	await session.prompt("start job");
	const pgid = await job.pgid();
	await session.extensionRunner.emit({
		type: "session_shutdown",
		reason: "quit",
	});
	expect(tree.closed).toBe(true);
	expect(await isProcessGroupActive(pgid)).toBe(true);
	await job.release();
	await waitForGroupToFinish(pgid);
	expect(existsSync(job.finished)).toBe(true);
	expect(exits(session)).toHaveLength(0);
});

test("a configured bash override in the parent is neither replaced nor tracked", async () => {
	const { session, job } = await setup(checked, [remoteBash]);
	expect(session.getToolDefinition("bash")?.promptGuidelines).toEqual([
		"REMOTE_BASH_MARKER",
	]);
	await session.prompt("start job");
	expect(existsSync(job.group)).toBe(false);
	expect(
		await session.extensionRunner.emitUserBash({
			type: "user_bash",
			command: "true",
			excludeFromContext: false,
			cwd: session.sessionManager.getCwd(),
		}),
	).toBeUndefined();
});
