import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionContext,
	type ExtensionFactory,
	type SettingsManager,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { SessionOwner } from "../runtime/index.ts";
import {
	isProcessGroupActive,
	waitForGroupToFinish,
} from "./process-groups.ts";
import { COMMAND_EXIT_TYPE } from "./protocol.ts";

/** Keep command groups in the delegated run's completion gate, not in a tool or
 * agent event handler: the session must remain free to converse while they run.
 */
export function backgroundCommands(
	owner: SessionOwner,
	settings: SettingsManager,
): ExtensionFactory {
	return (pi) => {
		const groups = new Map<number, AbortController>();
		let shuttingDown = false;
		let epoch = 0;
		let sessionContext: ExtensionContext | undefined;
		let unsubscribe = () => {};
		const commandPrefix = settings.getShellCommandPrefix();
		const report = (error: unknown) =>
			owner.runtime.trackCompletion(owner.id, Promise.reject(error));
		const stop = (pgid: number, controller: AbortController) => {
			try {
				process.kill(-pgid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") report(error);
			} finally {
				controller.abort();
			}
		};
		const stopAll = () => {
			// Fence notifications too, including groups that exited before cancellation.
			epoch++;
			for (const [pgid, controller] of groups) stop(pgid, controller);
		};
		const track = (
			pgid: number,
			command: string,
			cwd: string,
			cancelled: boolean,
		) => {
			const controller = new AbortController();
			const session = owner.runtime.get(owner.id)?.session;
			const context = sessionContext;
			const sessionId = session?.sessionId;
			const startedEpoch = epoch;
			const canDeliver = () => {
				const node = owner.runtime.get(owner.id);
				if (
					!session ||
					!context ||
					sessionContext !== context ||
					shuttingDown ||
					owner.runtime.closed ||
					controller.signal.aborted ||
					epoch !== startedEpoch ||
					node?.cancelled ||
					node?.status !== "running" ||
					node.session !== session
				)
					return false;
				try {
					return (
						context.sessionManager === session.sessionManager &&
						context.sessionManager.getSessionId() === sessionId
					);
				} catch {
					return false;
				}
			};
			groups.set(pgid, controller);
			let exited = false;
			const completion = waitForGroupToFinish(pgid, controller.signal)
				.then(async () => {
					exited = true;
					// Never signal a finished (and possibly reused) PGID while the LLM
					// processes its notification. The completion promise still fences done.
					groups.delete(pgid);
					if (!canDeliver() || !session) return;
					if (session.isCompacting && !session.isStreaming)
						await session.waitForIdle();
					if (!canDeliver()) return;
					const preview = truncateHead(command, {
						maxLines: 20,
						maxBytes: 4096,
					});
					await session.sendCustomMessage(
						{
							customType: COMMAND_EXIT_TYPE,
							content: `Process group ${pgid} exited; background exit status unknown.\ncwd: ${cwd}\ncommand:\n${preview.content}${preview.truncated ? "\n[command truncated]" : ""}`,
							display: true,
							details: { pgid, command, cwd, exitCode: null },
						},
						{ deliverAs: "steer", triggerTurn: true },
					);
				})
				.catch((error: unknown) => {
					if (
						controller.signal.aborted ||
						epoch !== startedEpoch ||
						shuttingDown
					)
						return;
					if (!exited) stop(pgid, controller);
					throw error;
				})
				.finally(() => {
					if (groups.get(pgid) === controller) groups.delete(pgid);
				});
			owner.runtime.trackCompletion(owner.id, completion);
			if (cancelled || shuttingDown || owner.runtime.get(owner.id)?.cancelled)
				stop(pgid, controller);
		};

		async function recordGroup(
			path: string,
			command: string,
			cwd: string,
			cancelled: boolean,
		): Promise<void> {
			let pid: string;
			try {
				pid = await readFile(path, "utf8");
			} catch (error) {
				// Failed spawn, invalid timeout, or a shell syntax error: the
				// command never ran, so there is no group to keep waiting for.
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
			const pgid = Number(pid.trim());
			if (!/^\d+\s*$/.test(pid) || !Number.isSafeInteger(pgid) || pgid <= 1)
				throw new Error(`Invalid command process group: ${pid}`);
			// Foreground-only commands are already reported by their tool result.
			// Only groups that outlive the shell/tool need an asynchronous wakeup.
			if (await isProcessGroupActive(pgid))
				track(pgid, command, cwd, cancelled);
		}

		const operations: BashOperations = {
			async exec(command, cwd, options) {
				if (process.platform === "win32")
					throw new Error(
						"Command completion tracking requires POSIX process groups.",
					);
				options.signal?.throwIfAborted();
				const directory = await mkdtemp(
					join(tmpdir(), "pi-subagents-command-"),
				);
				const path = join(directory, "pgid");
				try {
					// Pi's local backend starts a detached shell: $$ is its PGID. A
					// private side channel preserves stdout/stderr, streaming, timeouts,
					// shell configuration and the built-in inherited-pipe handling.
					const quoted = `'${path.replaceAll("'", "'\\''")}'`;
					return await createLocalBashOperations({
						shellPath: settings.getShellPath(),
					}).exec(
						`command printf '%s\\n' "$$" > ${quoted} || exit\n${command}`,
						cwd,
						options,
					);
				} finally {
					// Fail settlement if tracking fails, even when the model handles
					// a tool error. Preserve any original command exception.
					// Do not expose configuration-only shell prefixes in model messages.
					const submitted =
						commandPrefix && command.startsWith(`${commandPrefix}\n`)
							? command.slice(commandPrefix.length + 1)
							: command;
					await recordGroup(
						path,
						submitted,
						cwd,
						options.signal?.aborted === true,
					).catch(report);
					await rm(directory, { recursive: true, force: true }).catch(report);
				}
			},
		};
		const cwd = owner.runtime.get(owner.id)?.context.cwd;
		if (!cwd) throw new Error("Missing subagent command context.");
		pi.registerTool({
			...createBashToolDefinition(cwd, {
				operations,
				commandPrefix,
			}),
			// Replace execution without enabling a tool excluded by defaultTools.
			defaultActive: false,
		});
		pi.on("user_bash", () => ({ operations }));
		pi.on("session_start", (_event, ctx) => {
			unsubscribe();
			stopAll();
			sessionContext = ctx;
			unsubscribe = owner.runtime.subscribe(() => {
				if (owner.runtime.get(owner.id)?.cancelled) stopAll();
			});
		});
		pi.on("session_shutdown", () => {
			shuttingDown = true;
			sessionContext = undefined;
			unsubscribe();
			stopAll();
		});
	};
}
