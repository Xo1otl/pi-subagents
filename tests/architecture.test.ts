import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

async function sources(directory: string): Promise<string[]> {
	const entries = await readdir(directory, { withFileTypes: true });
	return (
		await Promise.all(
			entries.map((entry) => {
				const path = join(directory, entry.name);
				return entry.isDirectory()
					? sources(path)
					: path.endsWith(".ts")
						? [path]
						: [];
			}),
		)
	).flat();
}

function dependencies(text: string): string[] {
	// Include type imports and explicit loader paths, not only emitted JS imports.
	return [
		...text.matchAll(
			/(?:\bfrom\s+|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*|\bnew\s+URL\s*\(\s*)(["'])([^"']+)\1/g,
		),
	].flatMap((match) => (match[2] ? [match[2]] : []));
}

test("dependency checks include type imports, dynamic imports, and explicit loader paths", () => {
	expect(
		dependencies(`
		import type { View } from "../ui/view.ts";
		export { thing } from "./thing.ts";
		import "./side-effect.ts";
		import("../ui/index.ts");
		require("./legacy.ts");
		new URL("../index.ts", import.meta.url);
	`),
	).toEqual([
		"../ui/view.ts",
		"./thing.ts",
		"./side-effect.ts",
		"../ui/index.ts",
		"./legacy.ts",
		"../index.ts",
	]);
});

test.each(["runtime", "agent"])(
	"%s cannot depend on UI, even through a loader path",
	async (layer) => {
		const allowed = layer === "runtime" ? ["runtime"] : ["runtime", "agent"];
		for (const path of await sources(join(root, layer))) {
			for (const dependency of dependencies(await readFile(path, "utf8"))) {
				expect(dependency).not.toBe("@earendil-works/pi-tui");
				if (!dependency.startsWith(".")) continue;
				const target = resolve(dirname(path), dependency);
				expect(
					allowed.some((directory) =>
						target.startsWith(`${join(root, directory)}/`),
					),
				).toBe(true);
			}
		}
	},
);

test("ui reaches agent only through its protocol, which leads nowhere else", async () => {
	const agent = join(root, "agent");
	const protocol = join(agent, "protocol.ts");
	for (const path of await sources(join(root, "ui"))) {
		for (const dependency of dependencies(await readFile(path, "utf8"))) {
			const target = resolve(dirname(path), dependency);
			if (target.startsWith(`${agent}/`)) expect(target).toBe(protocol);
		}
	}
	// Pure data and parsing: no file I/O, sessions, or completion formatting.
	for (const dependency of dependencies(await readFile(protocol, "utf8"))) {
		expect(dependency.startsWith("node:")).toBe(false);
		if (dependency.startsWith("."))
			expect(
				resolve(agent, dependency).startsWith(`${join(root, "runtime")}/`),
			).toBe(true);
	}
});

test("source modules have no import cycles", async () => {
	const files = [
		join(root, "index.ts"),
		...(
			await Promise.all(
				["runtime", "agent", "ui"].map((layer) => sources(join(root, layer))),
			)
		).flat(),
	];
	const graph = new Map<string, string[]>();
	for (const path of files)
		graph.set(
			path,
			dependencies(await readFile(path, "utf8"))
				.filter((dependency) => dependency.startsWith("."))
				.map((dependency) => resolve(dirname(path), dependency)),
		);
	const cycles: string[] = [];
	const visited = new Set<string>();
	const visit = (path: string, chain: readonly string[]): void => {
		const start = chain.indexOf(path);
		if (start >= 0) {
			cycles.push(
				[...chain.slice(start), path]
					.map((file) => relative(root, file))
					.join(" -> "),
			);
			return;
		}
		if (visited.has(path)) return;
		for (const next of graph.get(path) ?? []) visit(next, [...chain, path]);
		visited.add(path);
	};
	for (const path of graph.keys()) visit(path, []);
	expect(cycles).toEqual([]);
});
