export const MAX_DEPTH_SETTING = "subagents.maxDepth";

function field(value: unknown, key: string): unknown {
	return value && typeof value === "object"
		? Reflect.get(value, key)
		: undefined;
}

export function maxDepthSetting(settings: object): number | undefined {
	const value = field(field(settings, "subagents"), "maxDepth");
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number" && Number.isInteger(value) && value >= 1)
		return value;
	throw new Error(
		`Setting ${MAX_DEPTH_SETTING} must be a positive integer, not ${JSON.stringify(value)}.`,
	);
}
