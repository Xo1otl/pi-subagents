export const SLEEP_LIMIT_SECONDS = 25;

const TOKEN =
	/[^\S\n]+|\\\n|(?<heredoc><<-?)(?!<)|(?<operator>;;&?|;&|&&|\|\||\|&|[;|()\n]|&(?!>))|(?<part>'[^']*'?|"(?:\\[\s\S]|[^"\\])*"?|`(?:\\[\s\S]|[^`\\])*`?|\\[\s\S]?|&?[<>]+[&|]?|[^\s;&|()<>'"`\\]+)/y;

interface Heredoc {
	readonly delimiter: string;
	readonly tabs: boolean;
}

function heredocEnd(command: string, at: number, heredoc: Heredoc): number {
	while (at < command.length) {
		const newline = command.indexOf("\n", at);
		const end = newline < 0 ? command.length : newline;
		const line = command.slice(at, end);
		at = end + 1;
		if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter)
			break;
	}
	return at;
}

function shellTokens(command: string): string[] {
	const token = new RegExp(TOKEN);
	const tokens: string[] = [];
	const bodies: Heredoc[] = [];
	let awaiting: string | undefined;
	let word = "";
	for (let match = token.exec(command); match; match = token.exec(command)) {
		const { heredoc, operator, part } = match.groups ?? {};
		if (part && (word || !part.startsWith("#"))) {
			word += part;
			continue;
		}
		if (word) {
			tokens.push(word);
			if (awaiting)
				bodies.push({
					delimiter: word.replace(/['"\\]/g, ""),
					tabs: awaiting === "<<-",
				});
			awaiting = undefined;
			word = "";
		}
		awaiting = heredoc ?? awaiting;
		if (part) {
			const newline = command.indexOf("\n", token.lastIndex);
			token.lastIndex = newline < 0 ? command.length : newline;
		} else if (operator) {
			tokens.push(operator);
			if (operator === "\n")
				for (const body of bodies.splice(0))
					token.lastIndex = heredocEnd(command, token.lastIndex, body);
		}
	}
	if (word) tokens.push(word);
	return tokens;
}

const OPERATORS = new Set(["\n", ..."; & && || | |& ( ;; ;& ;;&".split(" ")]);
const KEYWORDS = new Set(
	"! { if then elif else while until do time".split(" "),
);
const CLOSERS = new Map([
	["(", ")"],
	["{", "}"],
	["if", "fi"],
	["case", "esac"],
	["for", "done"],
	["select", "done"],
	["while", "done"],
	["until", "done"],
]);
const UNIT_SECONDS: Readonly<Record<string, number>> = {
	m: 60,
	h: 3600,
	d: 86400,
};

function durationSeconds(arg: string): number {
	const match = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(arg);
	return match?.[1]
		? Number(match[1]) * (UNIT_SECONDS[match[2] ?? ""] ?? 1)
		: 0;
}

export function foregroundSleepSeconds(command: string): number {
	const closers: string[] = [];
	let seconds = 0;
	let pending = 0;
	let start = true;
	let sleeping = false;
	for (const token of shellTokens(command)) {
		const atStart: boolean = start;
		if (token === "\n" && atStart) continue;
		start = OPERATORS.has(token) || (atStart && KEYWORDS.has(token));
		const closer = CLOSERS.get(token);
		if (token === closers.at(-1) && (atStart || token === ")")) closers.pop();
		else if (closer && (atStart || token === "(" || token === "{")) {
			closers.push(closer);
			sleeping = false;
		} else if (closers.length) continue;
		else if (token === "&") pending = 0;
		else if (token === ";" || token === "\n") {
			seconds += pending;
			pending = 0;
		} else if (atStart) sleeping = token === "sleep";
		else if (sleeping) pending += durationSeconds(token);
	}
	return seconds + pending;
}
