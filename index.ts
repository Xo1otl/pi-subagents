import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSpawnTool } from "./agent/depth.ts";
import { createSubagentIntegration } from "./agent/index.ts";
import { createSubagentUI } from "./ui/index.ts";

export default function subagentsExtension(pi: ExtensionAPI): void {
	const ui = createSubagentUI(pi);
	const tool = createSubagentIntegration(pi, ui);
	registerSpawnTool(pi, { ...tool, ...ui.toolRenderers });
}
