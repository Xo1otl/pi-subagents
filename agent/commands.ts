import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SessionOwner } from "../runtime/index.ts";
import {
	isProcessGroupActive,
	waitForGroupToFinish,
} from "./process-groups.ts";
import { COMMAND_EXIT_TYPE, type CommandExitMessage } from "./protocol.ts";

/** Tells the conversation that ran a command of its exit, waking it if idle.
 * The signal aborts once the exit must no longer be told.
 */
export type CommandListener = (
	exit: CommandExitMessage,
	signal: AbortSignal,
) => void | Promise<void>;

/** The session whose local bash commands are tracked. */
export interface CommandHost {
	/** A delegated run's jobs end with it; the user's own outlive Pi. */
	readonly ownsJobs: boolean;
	/** Keep the session's settlement open until the work settles; a rejection
	 * is a tracking failure.
	 */
	track(work: Promise<void>, ctx: ExtensionContext): void;
	/** Capture the conversation running a command, unless it is already over. */
	listener(ctx: ExtensionContext): CommandListener | undefined;
}

export interface CommandTracking {
	/** Stop watching every group and withhold the exits not yet told. */
	stop(): void;
}

interface TrackedSession {
	readonly ctx: ExtensionContext;
	readonly shell: BashOperations;
	readonly prefix: string | undefined;
}

function commandExit(
	pgid: number,
	command: string,
	cwd: string,
): CommandExitMessage {
	// The agent already holds the full command; one line identifies the job.
	const [first = ""] = command.trim().split("\n");
	const chars = [...first];
	const preview =
		chars.length > 100 || command.trim().includes("\n")
			? `${chars.slice(0, 100).join("")}…`
			: first;
	return {
		customType: COMMAND_EXIT_TYPE,
		content: `Process group ${pgid} exited: ${preview}`,
		display: true,
		details: { pgid, command, cwd, exitCode: null },
	};
}

/** The group a command recorded, or undefined when it never ran: a failed
 * spawn, an invalid timeout or a shell syntax error leaves nothing to wait for.
 */
async function recordedGroup(path: string): Promise<number | undefined> {
	let pid: string;
	try {
		pid = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const pgid = Number(pid.trim());
	if (!/^\d+\s*$/.test(pid) || !Number.isSafeInteger(pgid) || pgid <= 1)
		throw new Error(`Invalid command process group: ${pid}`);
	return pgid;
}

/** Watch the process groups that a session's local bash commands leave behind.
 * They belong to the host's settlement, not to a tool or an agent event
 * handler: the session must remain free to converse while they run.
 */
export function trackCommands(
	pi: ExtensionAPI,
	host: CommandHost,
): CommandTracking {
	/** Running groups, by the session that started them. */
	const groups = new Map<number, ExtensionContext>();
	/** Replaced by every stop, so that exits not yet told are fenced too. */
	let scope = new AbortController();
	let session: TrackedSession | undefined;
	let installed = false;

	function end(pgid: number, ctx: ExtensionContext): void {
		if (!host.ownsJobs) return;
		try {
			process.kill(-pgid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH")
				host.track(Promise.reject(error), ctx);
		}
	}

	function stop(): void {
		scope.abort();
		scope = new AbortController();
		const running = [...groups];
		groups.clear();
		for (const [pgid, ctx] of running) end(pgid, ctx);
	}

	async function record(
		from: TrackedSession,
		path: string,
		command: string,
		cwd: string,
		aborted: boolean,
	): Promise<void> {
		const pgid = await recordedGroup(path);
		// Foreground-only commands are already reported by their tool result.
		// Only groups that outlive the shell/tool need an asynchronous wakeup.
		if (pgid === undefined || !(await isProcessGroupActive(pgid))) return;
		const { ctx } = from;
		const notify = aborted || from !== session ? undefined : host.listener(ctx);
		if (!notify) {
			end(pgid, ctx);
			return;
		}
		const { signal } = scope;
		groups.set(pgid, ctx);
		host.track(
			waitForGroupToFinish(pgid, signal)
				.then(async () => {
					if (signal.aborted) return;
					// Never signal a finished (and possibly reused) PGID while the
					// model handles its exit; the tracked work still gates settlement.
					groups.delete(pgid);
					await notify(commandExit(pgid, command, cwd), signal);
				})
				.catch((error: unknown) => {
					if (signal.aborted) return;
					// Watching failed while the group may still be running.
					if (groups.delete(pgid)) end(pgid, ctx);
					throw error;
				}),
			ctx,
		);
	}

	const operations: BashOperations = {
		async exec(command, cwd, options) {
			const from = session;
			if (!from) throw new Error("Command tracking ended with its session.");
			const fail = (error: unknown) =>
				host.track(Promise.reject(error), from.ctx);
			const directory = await mkdtemp(join(tmpdir(), "pi-subagents-command-"));
			const path = join(directory, "pgid");
			try {
				// Pi's local backend starts a detached shell: $$ is its PGID. A
				// private side channel preserves stdout/stderr, streaming, timeouts,
				// shell configuration and the built-in inherited-pipe handling.
				const quoted = `'${path.replaceAll("'", "'\\''")}'`;
				return await from.shell.exec(
					`command printf '%s\\n' "$$" > ${quoted} || exit\n${command}`,
					cwd,
					options,
				);
			} finally {
				// Do not expose configuration-only shell prefixes in model messages.
				const submitted =
					from.prefix && command.startsWith(`${from.prefix}\n`)
						? command.slice(from.prefix.length + 1)
						: command;
				// Tracking failures are the host's to report: they must neither
				// replace the command's own outcome nor pass for a handled tool error.
				await record(
					from,
					path,
					submitted,
					cwd,
					options.signal?.aborted === true,
				).catch(fail);
				await rm(directory, { recursive: true, force: true }).catch(fail);
			}
		},
	};

	pi.on("session_start", (_event, ctx) => {
		stop();
		session = undefined;
		// Tracking requires POSIX process groups, and only replaces Pi's own
		// backend: a configured override (for example remote execution) stays.
		installed ||=
			process.platform !== "win32" &&
			pi
				.getAllTools()
				.some(
					(tool) =>
						tool.name === "bash" && tool.sourceInfo.source === "builtin",
				);
		if (!installed) return;
		// The effective settings, read as Pi's own bash tool reads them.
		const settings = SettingsManager.inMemory(pi.getSettings());
		const prefix = settings.getShellCommandPrefix();
		session = {
			ctx,
			prefix,
			shell: createLocalBashOperations({ shellPath: settings.getShellPath() }),
		};
		const bash = createBashToolDefinition(ctx.cwd, {
			operations,
			commandPrefix: prefix,
		});
		pi.registerTool({
			...bash,
			promptGuidelines: [
				...(bash.promptGuidelines ?? []),
				"BG jobs (e.g., `nohup`) tracked via PGID; exit → notify + resume if idle. Output/exit code not included; capture to file.",
			],
			// Replace execution without enabling a tool excluded by defaultTools.
			defaultActive: false,
		});
	});
	// A `!!` command stays out of the model's context, and so does its exit.
	pi.on("user_bash", (event) =>
		session && !event.excludeFromContext ? { operations } : undefined,
	);
	pi.on("session_shutdown", () => {
		stop();
		session = undefined;
	});

	return { stop };
}

/** Track a delegated session's commands: their groups keep its run open,
 * resume it when they exit, and end with it.
 */
export function delegatedCommands({
	runtime,
	id,
}: SessionOwner): ExtensionFactory {
	return (pi) => {
		let unsubscribe = () => {};
		const commands = trackCommands(pi, {
			ownsJobs: true,
			// A failure fails the run, even when the model handles the tool error.
			track: (work) => runtime.trackCompletion(id, work),
			listener(ctx) {
				const session = runtime.get(id)?.session;
				if (!session) return undefined;
				const { sessionId } = session;
				const running = () => {
					const node = runtime.get(id);
					if (
						runtime.closed ||
						node?.cancelled ||
						node?.status !== "running" ||
						node.session !== session
					)
						return false;
					try {
						// This guarded getter also detects disposal and replacement.
						return (
							ctx.sessionManager === session.sessionManager &&
							ctx.sessionManager.getSessionId() === sessionId
						);
					} catch {
						return false;
					}
				};
				if (!running()) return undefined;
				return async (exit, signal) => {
					if (!running()) return;
					if (session.isCompacting && !session.isStreaming) {
						await session.waitForIdle();
						if (signal.aborted || !running()) return;
					}
					// Unlike pi.sendMessage (void), the SDK promise observes turn
					// startup failures, which fail the run instead of leaving a stale
					// final answer.
					await session.sendCustomMessage(exit, {
						deliverAs: "steer",
						triggerTurn: true,
					});
				};
			},
		});
		pi.on("session_start", () => {
			unsubscribe();
			unsubscribe = runtime.subscribe(() => {
				if (runtime.get(id)?.cancelled) commands.stop();
			});
		});
		pi.on("session_shutdown", () => unsubscribe());
	};
}
