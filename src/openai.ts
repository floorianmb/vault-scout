import { requestUrl } from "obsidian";
import { asRecord, asString, JsonRecord, parseJson } from "./json";

// https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
const API = "https://api.openai.com/v1";

export interface ModelInfo {
	slug: string;
	displayName: string;
}

export class ApiError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
		this.name = "ApiError";
	}
}

function apiError(data: unknown, status: number): ApiError {
	const record = asRecord(data);
	const error = asRecord(record?.error) ?? record;
	const code = asString(error?.code) ?? asString(error?.type) ?? `http_${status}`;
	return new ApiError(status, code, asString(error?.message) ?? `OpenAI request failed (${code}).`);
}

export async function listModels(token: string): Promise<ModelInfo[]> {
	const response = await requestUrl({ url: `${API}/models`, headers: { Authorization: `Bearer ${token}` }, throw: false });
	const data = asRecord(parseJson(response.text));
	if (response.status >= 400) throw apiError(data, response.status);
	const entries = Array.isArray(data?.models) ? data.models : Array.isArray(data?.data) ? data.data : [];
	const models: ModelInfo[] = [];
	for (const entry of entries) {
		const model = asRecord(entry);
		const slug = asString(model?.slug) ?? asString(model?.id);
		if (!slug || (model?.visibility !== undefined && model.visibility !== "list")) continue;
		models.push({ slug, displayName: asString(model?.display_name) ?? slug });
	}
	return models;
}

export interface TurnResult {
	output: JsonRecord[];
	incompleteReason?: string;
}

/**
 * One streamed Responses API call. Plan usage requires `stream: true` and
 * `store: false`. Uses fetch rather than requestUrl, which cannot stream; the
 * API allows cross-origin requests, also from the mobile app.
 */
export async function streamResponse(
	token: string,
	body: JsonRecord,
	onTextDelta: (delta: string) => void,
	signal: AbortSignal,
): Promise<TurnResult> {
	// Deliberately fetch (lint warning): requestUrl buffers the whole body, and plan usage requires streaming.
	const response = await fetch(`${API}/responses`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" },
		body: JSON.stringify({ ...body, stream: true, store: false }),
		signal,
	});
	if (!response.ok) throw apiError(parseJson(await response.text()), response.status);

	const items: JsonRecord[] = [];
	let final: JsonRecord | undefined;
	let incompleteReason: string | undefined;

	const handle = (event: JsonRecord) => {
		switch (event.type) {
			case "response.output_text.delta":
				if (typeof event.delta === "string") onTextDelta(event.delta);
				break;
			case "response.output_item.done": {
				const item = asRecord(event.item);
				if (item) items[typeof event.output_index === "number" ? event.output_index : items.length] = item;
				break;
			}
			case "response.completed":
				final = asRecord(event.response) ?? {};
				break;
			case "response.incomplete": {
				final = asRecord(event.response) ?? {};
				incompleteReason = asString(asRecord(final.incomplete_details)?.reason) ?? "unknown";
				break;
			}
			case "response.failed":
				throw apiError(asRecord(event.response)?.error ?? event, 200);
			case "error":
				throw apiError(event, 200);
		}
	};

	let buffer = "";
	const consume = (chunk: string, flush = false) => {
		buffer += chunk;
		const blocks = buffer.split(/\r?\n\r?\n/);
		buffer = flush ? "" : blocks.pop() ?? "";
		for (const block of blocks) {
			const data = block
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data || data === "[DONE]") continue;
			const event = asRecord(parseJson(data));
			if (event) handle(event);
		}
	};

	if (response.body) {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			consume(decoder.decode(value, { stream: true }));
		}
		consume(decoder.decode(), true);
	} else {
		consume(await response.text(), true);
	}

	if (!final) throw new ApiError(0, "stream_interrupted", "The response stream ended early. Please try again.");
	const finalOutput = Array.isArray(final.output) ? final.output.map(asRecord).filter((i): i is JsonRecord => !!i) : [];
	return { output: finalOutput.length ? finalOutput : items.filter(Boolean), incompleteReason };
}
