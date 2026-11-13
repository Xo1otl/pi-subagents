import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Wait independently of the shell/tool, without blocking the agent's turn.
 * Polling backs off, as a job may be a server that runs for days.
 */
export async function waitForGroupToFinish(
	pgid: number,
	signal?: AbortSignal,
): Promise<void> {
	for (
		let delay = 100;
		await isProcessGroupActive(pgid, signal);
		delay = Math.min(delay * 2, 1000)
	)
		await setTimeout(delay, undefined, { signal });
}

/** A shell can exit before its background jobs, which retain its POSIX process
 * group even after reparenting (including nohup). Zombies have finished too;
 * kill(-pgid, 0) alone would wait forever on systems that do not reap them.
 * Processes that explicitly leave the group (setsid/setpgid) are not included.
 */
export async function isProcessGroupActive(
	pgid: number,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!Number.isSafeInteger(pgid) || pgid <= 1)
		throw new Error(`Invalid process group: ${pgid}`);
	if (process.platform === "win32")
		throw new Error(
			"Command completion tracking requires POSIX process groups.",
		);
	signal?.throwIfAborted();
	try {
		process.kill(-pgid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
	const { stdout } = await exec("ps", ["-A", "-o", "pgid=,stat="], {
		signal,
		timeout: 5000,
		maxBuffer: 16 * 1024 * 1024,
	});
	return stdout.split("\n").some((line) => {
		if (!line.trim()) return false;
		const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
		if (!match) throw new Error(`Invalid process status: ${line}`);
		return Number(match[1]) === pgid && !/^[ZX]/.test(match[2] ?? "");
	});
}
