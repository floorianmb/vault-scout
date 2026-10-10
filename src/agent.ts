import { ChatGPTAuth } from "./auth";
import type { ChatTurn } from "./chats";
import { asString, JsonRecord } from "./json";
import { ApiError, streamResponse, TurnResult } from "./openai";
import { ToolCall, VaultTools } from "./tools";

const MAX_ROUNDS = 16;
/** Tool results older than the last few are shortened to keep long chats within the context window. */
const KEEP_TOOL_RESULTS = 8;
const OLD_RESULT_LIMIT = 1500;
/** Tools without side effects; several of them in one round run in parallel. */
const READ_ONLY = new Set(["search_notes", "read_note", "list_folder", "get_links", "get_properties", "read_skill_file", "load_skill"]);

const INSTRUCTIONS = `You are Vault Scout, a research assistant inside the user's Obsidian vault.
- Before answering questions about the user's knowledge, search and read the relevant notes with your tools. Do several searches with different keywords and synonyms, also in the other languages the notes are written in, when the first one finds little.
- The vault overview below shows the folders and the root index. Use it instead of listing the root or reading the root index.md again. Folder index notes (index.md) and frontmatter descriptions summarize the rest.
- Call independent read tools together in one turn; they run in parallel. Do not re-read a note you already read in this chat unless it changed.
- Cite every note you rely on as a Markdown link with its vault path, URL-encoding spaces, e.g. [Title](Folder/My%20Note.md).
- Clearly separate what the notes say from your own general knowledge. If the notes do not cover something, say so.
- You can create, change and rename notes. Every change is shown to the user for approval. Prefer small edit_note changes over rewriting and set_properties for frontmatter, and never change existing text of the user unless asked. If the user rejects a change, do not retry it unchanged.
- When something is ambiguous and matters (which note, which option), ask with ask_user instead of guessing.
- Answer in the user's language, concisely, in Markdown.`;

/** Text the user selected in a note, sent along as the scope of the question. */
export interface Selection {
	path: string;
	text: string;
	fromLine: number;
	toLine: number;
}

export interface UserMessage {
	text: string;
	/** Images as data URLs. */
	images: string[];
	selection?: Selection;
}

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
	/** Loaded skills, kept in the instructions so they are never shortened or loaded twice. */
	private skills = new Map<string, string>();

	constructor(private auth: ChatGPTAuth, private tools: VaultTools) {}

	reset(): void {
		this.history = [];
		this.skills.clear();
	}

	loadedSkills(): string[] {
		return [...this.skills.keys()];
	}

	/** Continues a saved chat. Tool calls are not saved, so only questions, answers and loaded skills return. */
	async load(turns: ChatTurn[], skills: string[]): Promise<void> {
		this.reset();
		this.history = turns.flatMap((turn) => [
			{ role: "user", content: turn.user },
			...(turn.answer ? [{ role: "assistant", content: turn.answer }] : []),
		]);
		for (const name of skills) await this.loadSkill(name);
	}

	async send(message: UserMessage, model: string, extraInstructions: string, events: AgentEvents, signal: AbortSignal): Promise<string | undefined> {
		this.history.push({ role: "user", content: userContent(message) });
		const overview = await this.tools.overview();
		const instructions = () =>
			[
				INSTRUCTIONS,
				`Current time (UTC): ${new Date().toISOString().slice(0, 19)}Z. Model: ${model}.`,
				overview,
				this.tools.skillsPrompt(this.loadedSkills()),
				...[...this.skills].map(([name, body]) => `# Loaded skill: ${name}\n\n${body}`),
				extraInstructions.trim(),
			]
				.filter(Boolean)
				.join("\n\n");

		for (let round = 0; round < MAX_ROUNDS; round++) {
			this.compact();
			const result = await this.request({
				model,
				instructions: instructions(),
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

			const parsed = calls.map((item) => ({ item, call: this.tools.parse(asString(item.name) ?? "", asString(item.arguments) ?? "{}") }));
			for (const { call } of parsed) events.onTool(call);
			const outputs = parsed.every(({ call }) => READ_ONLY.has(call.name))
				? await Promise.all(parsed.map(({ call }) => this.execute(call)))
				: await sequential(parsed.map(({ call }) => () => this.execute(call)));
			signal.throwIfAborted();
			parsed.forEach(({ item }, i) => this.history.push({ type: "function_call_output", call_id: item.call_id, output: outputs[i] }));
		}
		return "max_tool_rounds";
	}

	private async execute(call: ToolCall): Promise<string> {
		if (call.name !== "load_skill") return this.tools.execute(call);
		const name = asString(call.args.name) ?? "";
		if (this.skills.has(name)) return JSON.stringify({ already_loaded: name });
		const loaded = await this.loadSkill(name);
		return JSON.stringify(loaded ? { loaded, note: "Its instructions are now part of your instructions. Follow them." } : { error: "Unknown skill." });
	}

	private async loadSkill(name: string): Promise<string | undefined> {
		const skill = await this.tools.skillText(name);
		if (skill) this.skills.set(skill.name, skill.text);
		return skill?.name;
	}

	private compact() {
		// Images are sent with their own question only; earlier ones become a short note.
		const users = this.history.filter((item) => item.role === "user");
		for (const item of users.slice(0, -1)) {
			if (!Array.isArray(item.content)) continue;
			const parts = item.content as JsonRecord[];
			if (!parts.some((part) => part.type === "input_image")) continue;
			const count = parts.filter((part) => part.type === "input_image").length;
			item.content = [
				...parts.filter((part) => part.type !== "input_image"),
				{ type: "input_text", text: `[${count} image${count === 1 ? "" : "s"} attached earlier, not sent again]` },
			];
		}
		const results = this.history.filter((item) => item.type === "function_call_output");
		for (const item of results.slice(0, -KEEP_TOOL_RESULTS)) {
			if (typeof item.output === "string" && item.output.length > OLD_RESULT_LIMIT) {
				item.output = `${item.output.slice(0, OLD_RESULT_LIMIT)}… [shortened; call the tool again if you need the rest]`;
			}
		}
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

async function sequential<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
	const results: T[] = [];
	for (const task of tasks) results.push(await task());
	return results;
}

/** The user's text, the selected passage as scope, and attached images as Responses input parts. */
function userContent(message: UserMessage): string | JsonRecord[] {
	let text = message.text;
	const selection = message.selection;
	if (selection) {
		const lines = selection.fromLine === selection.toLine ? `line ${selection.fromLine}` : `lines ${selection.fromLine}-${selection.toLine}`;
		text += `\n\nSelected passage from ${selection.path} (${lines}):\n<selection>\n${selection.text}\n</selection>\n` +
			"The question is about this passage. Unless the user asks for more, limit any change to it, using edit_note with this exact text.";
	}
	if (!message.images.length) return text;
	return [{ type: "input_text", text }, ...message.images.map((url) => ({ type: "input_image", image_url: url }))];
}
