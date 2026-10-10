import { App, FuzzySuggestModal, moment, normalizePath, TFile } from "obsidian";
import { ensureFolder } from "./skills";

export const CHAT_TYPE = "Agent Chat";

/** One question with the research steps and the answer it produced. */
export interface ChatTurn {
	user: string;
	steps: string[];
	answer: string;
}

export interface Chat {
	file: TFile | null;
	title: string;
	created: string;
	model: string;
	/** Skills loaded in this chat, restored when it is continued. */
	skills: string[];
	turns: ChatTurn[];
}

const MARKER = /^<!-- vault-scout:(user|steps|answer) -->$/m;

/**
 * Chats are Markdown notes, so they sync, can be read and linked, and the
 * agent can find earlier research. HTML comments mark the sections for
 * reading a chat back; they are invisible in reading view.
 */
export class ChatStore {
	constructor(private app: App, private folder: () => string) {}

	newChat(model: string): Chat {
		return { file: null, title: "", created: new Date().toISOString(), model, skills: [], turns: [] };
	}

	isChat(file: TFile): boolean {
		return this.app.metadataCache.getFileCache(file)?.frontmatter?.type === CHAT_TYPE;
	}

	/** Chats in the chat folder, most recently changed first. */
	list(): TFile[] {
		const prefix = `${normalizePath(this.folder())}/`;
		return this.app.vault
			.getMarkdownFiles()
			.filter((file) => file.path.startsWith(prefix) && this.isChat(file))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
	}

	titleOf(file: TFile): string {
		const title: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.title;
		return typeof title === "string" && title ? title : file.basename;
	}

	async load(file: TFile): Promise<Chat> {
		const content = await this.app.vault.read(file);
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const end = this.app.metadataCache.getFileCache(file)?.frontmatterPosition?.end.offset ?? 0;
		const parts = content.slice(end).split(MARKER);
		const turns: ChatTurn[] = [];
		for (let i = 1; i + 1 < parts.length; i += 2) {
			const kind = parts[i];
			const text = parts[i + 1] ?? "";
			if (kind === "user") {
				const lines = text.trim().split("\n");
				if (lines[0]?.startsWith("> [!question]")) lines.shift();
				turns.push({ user: lines.map((line) => line.replace(/^> ?/, "")).join("\n").trim(), steps: [], answer: "" });
			} else if (kind === "steps" && turns.length) {
				turns[turns.length - 1]!.steps = text
					.split("\n")
					.filter((line) => line.startsWith("> - "))
					.map((line) => line.slice(4).trim());
			} else if (kind === "answer" && turns.length) {
				turns[turns.length - 1]!.answer = text.trim();
			}
		}
		const string = (value: unknown) => (typeof value === "string" ? value : "");
		return {
			file,
			title: string(frontmatter?.title) || file.basename,
			created: string(frontmatter?.created) || new Date(file.stat.ctime).toISOString(),
			model: string(frontmatter?.model),
			skills: Array.isArray(frontmatter?.skills) ? (frontmatter.skills as unknown[]).filter((s): s is string => typeof s === "string") : [],
			turns,
		};
	}

	/** Writes the chat, creating its note on the first save. */
	async save(chat: Chat): Promise<TFile> {
		if (!chat.title) chat.title = titleFrom(chat.turns[0]?.user ?? "Chat");
		const content = serialize(chat);
		if (chat.file && this.app.vault.getFileByPath(chat.file.path)) {
			await this.app.vault.modify(chat.file, content);
			return chat.file;
		}
		const folder = normalizePath(this.folder());
		await ensureFolder(this.app, folder);
		const stamp = moment(chat.created).format("YYYY-MM-DD HHmm");
		const base = `${folder}/${stamp} ${fileSafe(chat.title)}`;
		let path = `${base}.md`;
		for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = `${base} ${n}.md`;
		chat.file = await this.app.vault.create(path, content);
		return chat.file;
	}
}

function serialize(chat: Chat): string {
	const yaml = (value: string) => JSON.stringify(value);
	const lines = [
		"---",
		`type: ${CHAT_TYPE}`,
		`title: ${yaml(chat.title)}`,
		`created: ${yaml(chat.created)}`,
		`updated: ${yaml(new Date().toISOString())}`,
		...(chat.model ? [`model: ${yaml(chat.model)}`] : []),
		...(chat.skills.length ? [`skills: ${JSON.stringify(chat.skills)}`] : []),
		"---",
	];
	for (const turn of chat.turns) {
		lines.push("", "<!-- vault-scout:user -->", "> [!question] You", ...turn.user.split("\n").map((line) => `> ${line}`));
		if (turn.steps.length) {
			lines.push("", "<!-- vault-scout:steps -->", "> [!abstract]- Research steps", ...turn.steps.map((step) => `> - ${step}`));
		}
		if (turn.answer) lines.push("", "<!-- vault-scout:answer -->", turn.answer);
	}
	return `${lines.join("\n")}\n`;
}

function titleFrom(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "Chat";
}

function fileSafe(title: string): string {
	return title.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim().slice(0, 50) || "Chat";
}

export class ChatPickerModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private store: ChatStore, private onPick: (file: TFile) => void) {
		super(app);
		this.setPlaceholder("Open a chat…");
	}

	getItems(): TFile[] {
		return this.store.list();
	}

	getItemText(file: TFile): string {
		return `${this.store.titleOf(file)} · ${new Date(file.stat.mtime).toLocaleDateString()}`;
	}

	onChooseItem(file: TFile): void {
		this.onPick(file);
	}
}
