import { ChatGPTAuth } from "./auth";
import { asString, JsonRecord } from "./json";
import { ApiError, streamResponse, TurnResult } from "./openai";
import { ToolCall, VaultTools } from "./tools";

const MAX_ROUNDS = 16;

const INSTRUCTIONS = `You are Vault Scout, a research assistant inside the user's Obsidian vault.
- Before answering questions about the user's knowledge, search and read the relevant notes with your tools. Do several searches with different keywords (German and English) when the first one finds little.
- Index notes (index.md) and frontmatter descriptions summarize folders; use them to orient yourself.
- Cite every note you rely on as a Markdown link with its vault path, URL-encoding spaces, e.g. [Title](Folder/My%20Note.md).
- Clearly separate what the notes say from your own general knowledge. If the notes do not cover something, say so.
- Answer in the user's language, concisely, in Markdown.`;

export interface AgentEvents {
	onText(delta: string): void;
	onTool(call: ToolCall): void;
	onRoundEnd(): void;
}

/**
 * Keeps the conversation client-side: with `store: false` the API does not
 * remember earlier turns, so each request resends the whole history.
 */
export class Agent {
	private history: JsonRecord[] = [];
	private sendReasoning = true;

	constructor(private auth: ChatGPTAuth, private tools: VaultTools) {}

	reset(): void {
		this.history = [];
	}

	async send(text: string, model: string, extraInstructions: string, events: AgentEvents, signal: AbortSignal): Promise<string | undefined> {
		this.history.push({ role: "user", content: text });
		const instructions = extraInstructions.trim() ? `${INSTRUCTIONS}\n\n${extraInstructions.trim()}` : INSTRUCTIONS;

		for (let round = 0; round < MAX_ROUNDS; round++) {
			const result = await this.request({
				model,
				instructions,
				input: this.history,
				tools: this.tools.definitions(),
				...(this.sendReasoning ? { include: ["reasoning.encrypted_content"] } : {}),
			}, events, signal);

			const calls: JsonRecord[] = [];
			for (const item of result.output) {
				const input = this.toInput(item);
				if (input) this.history.push(input);
				if (item.type === "function_call") calls.push(item);
			}
			events.onRoundEnd();
			if (!calls.length) return result.incompleteReason;

			for (const item of calls) {
				const call = this.tools.parse(asString(item.name) ?? "", asString(item.arguments) ?? "{}");
				events.onTool(call);
				const output = await this.tools.execute(call);
				signal.throwIfAborted();
				this.history.push({ type: "function_call_output", call_id: item.call_id, output });
			}
		}
		return "max_tool_rounds";
	}

	private async request(body: JsonRecord, events: AgentEvents, signal: AbortSignal, retried = false): Promise<TurnResult> {
		try {
			return await streamResponse(await this.auth.accessToken(retried), body, (delta) => events.onText(delta), signal);
		} catch (error) {
			if (retried || !(error instanceof ApiError)) throw error;
			if (error.status === 401) return this.request(body, events, signal, true);
			// Encrypted reasoning carries reasoning across turns without stored state.
			// Fall back to plain turns if plan usage rejects the parameter.
			if (error.status === 400 && this.sendReasoning && /include|reasoning/i.test(error.message)) {
				this.sendReasoning = false;
				this.history = this.history.filter((item) => item.type !== "reasoning");
				const { include: _include, ...rest } = body;
				return this.request({ ...rest, input: this.history }, events, signal, true);
			}
			throw error;
		}
	}

	/** Converts an output item into a self-contained input item (no stored IDs). */
	private toInput(item: JsonRecord): JsonRecord | undefined {
		switch (item.type) {
			case "message": {
				const parts = Array.isArray(item.content) ? (item.content as JsonRecord[]) : [];
				const text = parts.map((part) => asString(part.text) ?? asString(part.refusal) ?? "").join("");
				return text ? { role: "assistant", content: text } : undefined;
			}
			case "function_call":
				return { type: "function_call", call_id: item.call_id, name: item.name, arguments: item.arguments };
			case "reasoning":
				return this.sendReasoning && item.encrypted_content
					? { type: "reasoning", id: item.id, summary: item.summary ?? [], encrypted_content: item.encrypted_content }
					: undefined;
			default:
				return undefined;
		}
	}
}
