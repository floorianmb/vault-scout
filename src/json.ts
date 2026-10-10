export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}
