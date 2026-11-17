import { expect, test } from "bun:test";
import { foregroundSleepSeconds } from "../agent/sleep.ts";

test.each([
	["sleep 90; cat log", 90],
	["  sleep 25 && tail log", 25],
	["sleep 1m | cat", 60],
	["sleep 20 5\ncat log", 25],
	["sleep 1.5m >/dev/null 2>&1", 90],
	["sleep 24; cat log", 24],
	// Polls after other commands, and after launching the job they poll.
	["cd /abs/dir && sleep 240; date -u; tail log", 240],
	["push; sleep 20; status; sleep 150; status", 170],
	["nohup job > log 2>&1 & sleep 45; tail log", 45],
	["(setsid nohup job > log 2>&1 &); sleep 90; cat log", 90],
	["cmd &&\n  sleep 30\ntail log", 30],
	["echo 'a;b' \"c # d\"; sleep 30 # wait", 30],
	[
		"cat > run.sh <<'EOF'\nsleep 600\nEOF\nnohup ./run.sh > log 2>&1 &\nsleep 60; tail log",
		60,
	],
	// Sent to the background, nested, quoted or in a here-document.
	["sleep 90 & echo started", 0],
	["cd x && sleep 90 &", 0],
	["(sleep 90; kill $pid) &", 0],
	["until check; do sleep 90; done", 0],
	["nohup sh -c 'until check; do sleep 60; done' > log 2>&1 &", 0],
	["x=$(sleep 30; date)", 0],
	["f() {\n  sleep 60\n}", 0],
	["cat > run.sh <<'EOF'\nsleep 600; tail log\nEOF", 0],
	["python - <<-PY\n\tsleep 60\n\tPY", 0],
	// Not a sleep command, or not one with a literal duration.
	["echo sleep 60 # sleep 60", 0],
	["timeout 40 sleep 30", 0],
	["sleepy 90; sleep $N", 0],
])("foregroundSleepSeconds(%p) is %p", (command, seconds) => {
	expect(foregroundSleepSeconds(command)).toBe(seconds);
});
