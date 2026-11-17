/** Claude Code's floor: shorter foreground sleeps, e.g. while a server starts,
 * run.
 */
export const SLEEP_LIMIT_SECONDS = 25;

/** A blank, a here-document operator, a control operator or a part of a word:
 * quoted text, an escape, a redirection (`2>&1`, `&>log`) or plain text.
 */
const TOKEN =
	/[^\S\n]+|\\\n|(?<heredoc><<-?)(?!<)|(?<operator>;;&?|;&|&&|\|\||\|&|[;|()\n]|&(?!>))|(?<part>'[^']*'?|"(?:\\[\s\S]|[^"\\])*"?|`(?:\\[\s\S]|[^`\\])*`?|\\[\s\S]?|&?[<>]+[&|]?|[^\s;&|()<>'"`\\]+)/y;

interface Heredoc {
	readonly delimiter: string;
	/** `<<-` strips leading tabs. */
	readonly tabs: boolean;
}

/** Past the delimiter line of a here-document whose body starts at `at`. */
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

/** The words and control operators of a command, as the shell splits them.
 * Words keep quotes, escapes and redirections verbatim; comments and
 * here-document bodies are dropped.
 */
function shellTokens(command: string): string[] {
	const token = new RegExp(TOKEN);
	const tokens: string[] = [];
	/** Here-documents whose bodies start after the next newline. */
	const bodies: Heredoc[] = [];
	/** A here-document operator awaiting its delimiter, the next word. */
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
			// A comment runs to the end of its line.
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

/** Control operators, after which a command is due; not `)`, as a newline
 * after it ends the list.
 */
const OPERATORS = new Set(["\n", ..."; & && || | |& ( ;; ;& ;;&".split(" ")]);
/** Reserved words after which a command is due. */
const KEYWORDS = new Set(
	"! { if then elif else while until do time".split(" "),
);
/** The closing word of each compound command's opening one. Only `(` and `{`
 * open anywhere (a substitution, a function body); the rest open a command.
 */
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

/** Seconds that a command spends in `sleep`s at its top level, in the
 * foreground: wherever they are (`cd x && sleep 90; tail log`, `job & sleep
 * 90`). A sleep sent to the background (`sleep 90 &`), nested in a loop, group
 * or substitution, quoted (`sh -c '…'`) or in a here-document does not count.
 */
export function foregroundSleepSeconds(command: string): number {
	/** Closing words of the compound commands open here. */
	const closers: string[] = [];
	let seconds = 0;
	/** Seconds of the current list, unless it ends with `&`. */
	let pending = 0;
	/** Whether a command is due: the next word names it. */
	let start = true;
	/** Whether the current command is `sleep`. */
	let sleeping = false;
	for (const token of shellTokens(command)) {
		const atStart: boolean = start;
		// A newline where a command is due, e.g. after `&&`, is blank.
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
