import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Subagent, Subagents } from "../runtime/index.ts";
import { statusLabel } from "./text.ts";

const WIDGET_KEY = "pi-subagents.running";
const LISTED_IDS = 3;

function summarize(nodes: readonly Subagent[]): string {
	const active = nodes.filter((node) => node.status === "running");
	if (!active.length) return "";
	const counts = Map.groupBy(active, statusLabel);
	const parts = ["running", "interrupted", "stopping"].flatMap((label) => {
		const count = counts.get(label)?.length;
		return count ? [`${count} ${label}`] : [];
	});
	const ids = active.slice(0, LISTED_IDS).map((node) => node.id);
	if (active.length > LISTED_IDS) ids.push("…");
	parts.push(ids.join(", "));
	return `● Subagents: ${parts.join(" · ")}`;
}

export function bindRunningIndicator(
	runtime: Subagents,
	ui: Pick<ExtensionUIContext, "setWidget">,
): () => void {
	let summary = "";
	let disposed = false;

	function show(next: string): void {
		if (next === summary) return;
		summary = next;
		ui.setWidget(
			WIDGET_KEY,
			next
				? (_tui, theme) => ({
						render: (width) => [
							truncateToWidth(
								theme.fg("warning", next) +
									theme.fg("dim", " · ←← / Ctrl+Shift+A to view"),
								width,
							),
						],
						invalidate() {},
					})
				: undefined,
		);
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		unsubscribe();
		show("");
	}

	function update(): void {
		if (disposed) return;
		if (runtime.closed) dispose();
		else show(summarize(runtime.tree()));
	}

	const unsubscribe = runtime.subscribe(update);
	update();
	return dispose;
}
