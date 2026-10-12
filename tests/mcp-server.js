import { createInterface } from "node:readline";

for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	let result;
	switch (request.method) {
		case "initialize":
			result = {
				protocolVersion: request.params.protocolVersion,
				capabilities: { tools: {} },
				serverInfo: { name: "test", version: "1.0.0" },
			};
			break;
		case "tools/list":
			result = {
				tools: [
					{
						name: "echo",
						description: "Echo text",
						inputSchema: {
							type: "object",
							properties: { text: { type: "string" } },
							required: ["text"],
						},
					},
				],
			};
			break;
		case "tools/call":
			result = {
				content: [{ type: "text", text: request.params.arguments.text }],
			};
			break;
		default:
			result = {};
	}
	process.stdout.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
	);
}
