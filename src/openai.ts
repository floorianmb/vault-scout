import { Platform, requestUrl } from "obsidian";
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

/** Why answers arrive at once instead of streaming, if they do. */
export function streamingUnavailableReason(): string | undefined {
	return canStream() ? undefined : "the mobile app cannot stream plan-usage responses yet";
}

function canStream(): boolean {
	return Platform.isDesktop && Platform.isDesktopApp;
}

/**
 * One Responses API call with plan usage (`stream: true`, `store: false`).
 *
 * Successful plan-usage responses carry no CORS header (error responses do),
 * so the WebView blocks `fetch`. The desktop app therefore streams through
 * Node's https module, which has no CORS. The mobile app has no Node and its
 * requestUrl cannot stream, so there the whole event stream arrives at once.
 */
export async function streamResponse(
	token: string,
	body: JsonRecord,
	onTextDelta: (delta: string) => void,
	signal: AbortSignal,
): Promise<TurnResult> {
	const url = `${API}/responses`;
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "text/event-stream" };
	const payload = JSON.stringify({ ...body, stream: true, store: false });
	const parser = new EventParser(onTextDelta);

	if (canStream()) {
		await streamWithNode(url, headers, payload, parser, signal);
		return parser.result();
	}
	const response = await requestUrl({ url, method: "POST", headers, body: payload, throw: false });
	signal.throwIfAborted();
	if (response.status >= 400) throw apiError(parseJson(response.text), response.status);
	parser.consume(response.text, true);
	return parser.result();
}

async function streamWithNode(
	url: string,
	headers: Record<string, string>,
	payload: string,
	parser: EventParser,
	signal: AbortSignal,
): Promise<void> {
	if (!Platform.isDesktop) throw new Error("Streaming needs the desktop app.");
	const { request } = await import("https");
	const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));
	await new Promise<void>((resolve, reject) => {
		const req = request(url, { method: "POST", headers: { ...headers, "Content-Length": new TextEncoder().encode(payload).length } }, (res) => {
			res.setEncoding("utf8");
			const status = res.statusCode ?? 0;
			if (status >= 400) {
				let text = "";
				res.on("data", (chunk: string) => (text += chunk));
				res.on("end", () => reject(apiError(parseJson(text), status)));
				return;
			}
			res.on("data", (chunk: string) => {
				try {
					parser.consume(chunk);
				} catch (error) {
					req.destroy(asError(error));
				}
			});
			res.on("end", () => {
				try {
					parser.consume("", true);
					resolve();
				} catch (error) {
					reject(asError(error));
				}
			});
			res.on("error", (error) => reject(asError(error)));
		});
		const abort = () => req.destroy(new DOMException("Stopped.", "AbortError"));
		signal.addEventListener("abort", abort, { once: true });
		req.on("error", (error) => reject(asError(error)));
		req.on("close", () => signal.removeEventListener("abort", abort));
		req.end(payload);
	});
}

/** Parses Responses API server-sent events, from chunks or a whole body. */
class EventParser {
	private buffer = "";
	private items: JsonRecord[] = [];
	private final: JsonRecord | undefined;
	private incompleteReason: string | undefined;

	constructor(private onTextDelta: (delta: string) => void) {}

	/** Feeds raw server-sent event text. */
	consume(chunk: string, flush = false): void {
		this.buffer += chunk;
		const blocks = this.buffer.split(/\r?\n\r?\n/);
		this.buffer = flush ? "" : blocks.pop() ?? "";
		for (const block of blocks) {
			const data = block
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data || data === "[DONE]") continue;
			const event = asRecord(parseJson(data));
			if (event) this.handle(event);
		}
	}

	handle(event: JsonRecord): void {
		switch (event.type) {
			case "response.output_text.delta":
				if (typeof event.delta === "string") this.onTextDelta(event.delta);
				break;
			case "response.output_item.done": {
				const item = asRecord(event.item);
				if (item) this.items[typeof event.output_index === "number" ? event.output_index : this.items.length] = item;
				break;
			}
			case "response.completed":
				this.final = asRecord(event.response) ?? {};
				break;
			case "response.incomplete":
				this.final = asRecord(event.response) ?? {};
				this.incompleteReason = asString(asRecord(this.final.incomplete_details)?.reason) ?? "unknown";
				break;
			case "response.failed":
				throw apiError(asRecord(event.response)?.error ?? event, 200);
			case "error":
				throw apiError(event, typeof event.status === "number" ? event.status : 200);
		}
	}

	result(): TurnResult {
		const final = this.final;
		if (!final) throw new ApiError(0, "stream_interrupted", "The response stream ended early. Please try again.");
		const output = Array.isArray(final.output) ? final.output.map(asRecord).filter((i): i is JsonRecord => !!i) : [];
		return { output: output.length ? output : this.items.filter(Boolean), incompleteReason: this.incompleteReason };
	}
}
