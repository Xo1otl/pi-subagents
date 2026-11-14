import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isProcessGroupActive } from "../agent/process-groups.ts";
import { onCleanup, spawnContext, until } from "./fixtures.ts";

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
