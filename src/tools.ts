import { App, getAllTags, MarkdownView, normalizePath, prepareSimpleSearch, SearchResult, TFile, TFolder } from "obsidian";
import { confirmChange } from "./changes";
import { asRecord, asString, JsonRecord, parseJson } from "./json";
import type { VaultScoutSettings } from "./settings";
import { ensureFolder, SkillLibrary } from "./skills";

const TEXT_EXTENSIONS = new Set(["md", "txt", "canvas", "base", "csv", "json"]);
const SNIPPET_RADIUS = 90;
const PRISM_ERRORS = ".prism/errors.json";
const PRISM_WAIT = 10_000;

export interface ToolCall {
	name: string;
	args: JsonRecord;
}

const pathParam = (description: string) => ({ type: "string", description });

/** The model's tools: read the vault, change notes with the user's approval, load skills, check Prism blocks. */
export class VaultTools {
	constructor(private app: App, private settings: () => VaultScoutSettings, private skills: SkillLibrary) {}

	definitions(): JsonRecord[] {
		const tools: JsonRecord[] = [
			{
				type: "function",
				name: "search_notes",
				description:
					"Full-text search over the vault's Markdown notes (title, path and content). All words must appear; " +
					"if nothing matches, notes matching most words are returned. Use a few precise keywords, try synonyms " +
					"and the languages the notes are written in. Returns paths, frontmatter summary and matching snippets.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Space-separated keywords." },
						folder: { type: "string", description: "Only search inside this folder path." },
						tag: { type: "string", description: "Only notes with this tag, without #." },
						include_chats: { type: "boolean", description: "Also search earlier Vault Scout chats. Default false." },
						limit: { type: "integer", description: "Maximum results, 1-25. Default 10." },
					},
					required: ["query"],
				},
			},
			{
				type: "function",
				name: "read_note",
				description: "Read a note or text file. Long files are returned in chunks; continue with next_offset.",
				parameters: {
					type: "object",
					properties: {
						path: pathParam("Vault path, e.g. 'Folder/Note.md'. A note name also works."),
						offset: { type: "integer", description: "Character offset to start from. Default 0." },
					},
					required: ["path"],
				},
			},
			{
				type: "function",
				name: "list_folder",
				description: "List the subfolders and files of a folder. Use '' for the vault root. Index notes often summarize a folder.",
				parameters: { type: "object", properties: { path: pathParam("Folder path, '' for the root.") }, required: ["path"] },
			},
			{
				type: "function",
				name: "get_links",
				description: "Outgoing links, unresolved links and backlinks of a note, to follow related notes.",
				parameters: { type: "object", properties: { path: pathParam("Vault path of the note.") }, required: ["path"] },
			},
			{
				type: "function",
				name: "create_note",
				description: "Create a new Markdown note. The user reviews and approves it first. Fails if the note exists.",
				parameters: {
					type: "object",
					properties: {
						path: pathParam("Vault path ending in .md. Missing folders are created."),
						content: { type: "string", description: "Full note content, including frontmatter if needed." },
					},
					required: ["path", "content"],
				},
			},
			{
				type: "function",
				name: "edit_note",
				description:
					"Replace one exact passage of an existing note. old_text must appear exactly once; include enough surrounding text. " +
					"Read the note first. The user reviews and approves the change.",
				parameters: {
					type: "object",
					properties: {
						path: pathParam("Vault path of the note."),
						old_text: { type: "string", description: "Exact text to replace, copied from the note." },
						new_text: { type: "string", description: "Replacement text." },
					},
					required: ["path", "old_text", "new_text"],
				},
			},
			{
				type: "function",
				name: "append_to_note",
				description: "Append text to the end of an existing note. The user reviews and approves it.",
				parameters: {
					type: "object",
					properties: { path: pathParam("Vault path of the note."), content: { type: "string", description: "Text to append." } },
					required: ["path", "content"],
				},
			},
			{
				type: "function",
				name: "check_prism",
				description:
					"Check the Prism viz blocks of a note: opens the note so Prism renders it, then returns each block's status and errors " +
					"from .prism/errors.json. Call it after writing or changing viz blocks, fix errors, and check again.",
				parameters: { type: "object", properties: { path: pathParam("Vault path of the note.") }, required: ["path"] },
			},
		];
		if (this.skills.enabled().length) {
			tools.push(
				{
					type: "function",
					name: "load_skill",
					description: "Load a skill's instructions. Do this before a task that a listed skill covers.",
					parameters: { type: "object", properties: { name: { type: "string", description: "Skill name." } }, required: ["name"] },
				},
				{
					type: "function",
					name: "read_skill_file",
					description: "Read a further file of a loaded skill, such as a reference the skill points to.",
					parameters: {
						type: "object",
						properties: { name: { type: "string", description: "Skill name." }, file: { type: "string", description: "File path inside the skill." } },
						required: ["name", "file"],
					},
				},
			);
		}
		return tools;
	}

	/** Skill list for the instructions; empty when there are no skills. */
	skillsPrompt(loaded: string[]): string {
		const skills = this.skills.enabled();
		if (!skills.length) return "";
		return [
			"Skills: specialized instructions. When a task matches a skill that is not loaded yet, call load_skill first. Loaded skills appear below.",
			...skills.map((skill) => `- ${skill.name}${loaded.includes(skill.name) ? " (loaded)" : ""}: ${skill.description}`),
		].join("\n");
	}

	async skillText(name: string): Promise<{ name: string; text: string } | undefined> {
		const skill = await this.skills.load(name);
		return skill && { name: skill.name, text: skill.instructions };
	}

	/** Folder tree (two levels, with note counts) and the root index, so the model need not explore first. */
	async overview(): Promise<string> {
		const settings = this.settings();
		const skip = [settings.chatFolder, settings.skillsFolder].map((path) => normalizePath(path));
		const lines: string[] = [];
		const walk = (folder: TFolder, depth: number) => {
			for (const child of [...folder.children].sort((a, b) => a.name.localeCompare(b.name))) {
				if (!(child instanceof TFolder) || child.name.startsWith(".") || skip.includes(child.path)) continue;
				// A folder that only holds the chat and skills folders is Vault Scout's own.
				const own = child.children.every((c) => c instanceof TFolder && skip.includes(c.path));
				if (own && child.children.length) continue;
				const notes = child.children.filter((c) => c instanceof TFile && c.extension === "md").length;
				lines.push(`${"  ".repeat(depth)}- ${child.name}/ (${notes} notes${child.children.some((c) => c instanceof TFile && c.name === "index.md") ? ", has index.md" : ""})`);
				if (depth < 1 && lines.length < 150) walk(child, depth + 1);
			}
		};
		walk(this.app.vault.getRoot(), 0);
		const index = this.app.vault.getFileByPath("index.md");
		const indexText = index ? (await this.app.vault.cachedRead(index)).slice(0, 5000) : "";
		return [
			"# Vault overview",
			lines.length ? lines.join("\n") : "(no folders)",
			...(indexText ? ["Root index.md:", indexText] : []),
		].join("\n\n");
	}

	parse(name: string, argumentsJson: string): ToolCall {
		return { name, args: asRecord(parseJson(argumentsJson)) ?? {} };
	}

	async execute(call: ToolCall): Promise<string> {
		try {
			return JSON.stringify(await this.run(call));
		} catch (error) {
			return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async run({ name, args }: ToolCall): Promise<unknown> {
		switch (name) {
			case "search_notes":
				return this.search(args);
			case "read_note":
				return this.read(args);
			case "list_folder":
				return this.list(args);
			case "get_links":
				return this.links(args);
			case "create_note":
				return this.create(args);
			case "edit_note":
				return this.edit(args);
			case "append_to_note":
				return this.append(args);
			case "check_prism":
				return this.checkPrism(args);
			case "load_skill":
				return (await this.skills.load(asString(args.name) ?? "")) ?? { error: "Unknown skill." };
			case "read_skill_file": {
				const content = await this.skills.readFile(asString(args.name) ?? "", asString(args.file) ?? "");
				return content === undefined ? { error: "File not found in this skill." } : { content };
			}
			default:
				return { error: `Unknown tool ${name}` };
		}
	}

	private async search(args: JsonRecord) {
		const query = asString(args.query)?.trim();
		if (!query) return { error: "query is required" };
		const limit = Math.min(Math.max(typeof args.limit === "number" ? Math.round(args.limit) : 10, 1), 25);
		const folder = asString(args.folder)?.replace(/^\/+|\/+$/g, "");
		const tag = asString(args.tag)?.replace(/^#/, "").toLowerCase();
		const excluded = [this.settings().skillsFolder, ...(args.include_chats === true ? [] : [this.settings().chatFolder])]
			.map((path) => `${normalizePath(path)}/`);

		const files = this.app.vault.getMarkdownFiles().filter((file) => {
			if (excluded.some((prefix) => file.path.startsWith(prefix))) return false;
			if (folder && !file.path.startsWith(`${folder}/`)) return false;
			if (!tag) return true;
			const cache = this.app.metadataCache.getFileCache(file);
			const tags = cache ? getAllTags(cache) ?? [] : [];
			return tags.some((t) => t.slice(1).toLowerCase() === tag || t.slice(1).toLowerCase().startsWith(`${tag}/`));
		});

		const contents = new Map<TFile, string>();
		for (const file of files) contents.set(file, await this.app.vault.cachedRead(file));

		const all = prepareSimpleSearch(query);
		const terms = query.split(/\s+/).filter(Boolean).map((term) => prepareSimpleSearch(term));
		const rank = (file: TFile, strict: boolean) => {
			const content = contents.get(file) ?? "";
			const title = `${file.path} ${file.basename}`;
			if (strict) {
				const titleMatch = all(title);
				const contentMatch = all(content);
				if (!titleMatch && !contentMatch) return undefined;
				return { score: (titleMatch ? 50 : 0) + (contentMatch?.matches.length ?? 0), match: contentMatch };
			}
			const matched = terms.filter((term) => term(title) || term(content)).length;
			return matched ? { score: matched * 10, match: terms.map((term) => term(content)).find(Boolean) ?? null } : undefined;
		};

		let strict = true;
		let hits = files.map((file) => ({ file, result: rank(file, true) })).filter((hit) => hit.result);
		if (!hits.length && terms.length > 1) {
			strict = false;
			hits = files.map((file) => ({ file, result: rank(file, false) })).filter((hit) => hit.result);
		}
		hits.sort((a, b) => (b.result?.score ?? 0) - (a.result?.score ?? 0));

		return {
			query,
			match: strict ? "all words" : "some words",
			total: hits.length,
			results: hits.slice(0, limit).map(({ file, result }) => ({
				path: file.path,
				...this.summary(file),
				snippets: snippets(contents.get(file) ?? "", result?.match ?? null),
			})),
		};
	}

	private async read(args: JsonRecord) {
		const file = this.resolve(asString(args.path) ?? "");
		if (!file) return { error: "File not found. Use search_notes or list_folder to find the right path." };
		if (!TEXT_EXTENSIONS.has(file.extension)) return { error: `${file.extension} files cannot be read as text.` };
		const content = await this.app.vault.cachedRead(file);
		const offset = Math.max(typeof args.offset === "number" ? Math.round(args.offset) : 0, 0);
		const chunk = content.slice(offset, offset + 16000);
		const end = offset + chunk.length;
		return {
			path: file.path,
			total_chars: content.length,
			offset,
			content: chunk,
			...(end < content.length ? { next_offset: end } : {}),
		};
	}

	private list(args: JsonRecord) {
		const path = (asString(args.path) ?? "").replace(/^\/+|\/+$/g, "");
		const folder = path ? this.app.vault.getFolderByPath(path) : this.app.vault.getRoot();
		if (!folder) return { error: "Folder not found." };
		const folders: string[] = [];
		const files: string[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) folders.push(child.path);
			else files.push(child.path);
		}
		return { path: folder.path, folders: folders.sort(), files: files.sort().slice(0, 300), total_files: files.length };
	}

	private links(args: JsonRecord) {
		const file = this.resolve(asString(args.path) ?? "");
		if (!file) return { error: "File not found." };
		const { resolvedLinks, unresolvedLinks } = this.app.metadataCache;
		const backlinks: string[] = [];
		for (const [source, targets] of Object.entries(resolvedLinks)) {
			if (targets[file.path]) backlinks.push(source);
		}
		return {
			path: file.path,
			links: Object.keys(resolvedLinks[file.path] ?? {}).slice(0, 100),
			unresolved: Object.keys(unresolvedLinks[file.path] ?? {}).slice(0, 50),
			backlinks: backlinks.sort().slice(0, 100),
		};
	}

	private async create(args: JsonRecord) {
		const path = this.writablePath(asString(args.path) ?? "");
		const content = typeof args.content === "string" ? args.content : "";
		if (this.app.vault.getAbstractFileByPath(path)) return { error: "A file with this path exists. Use edit_note or append_to_note." };
		if (!(await this.approve({ action: "create", path, after: content }))) return declined;
		await ensureFolder(this.app, path.slice(0, Math.max(path.lastIndexOf("/"), 0)));
		await this.app.vault.create(path, content);
		return { created: path };
	}

	private async edit(args: JsonRecord) {
		const file = this.existingNote(asString(args.path) ?? "");
		const oldText = typeof args.old_text === "string" ? args.old_text : "";
		const newText = typeof args.new_text === "string" ? args.new_text : "";
		if (!oldText) return { error: "old_text is required." };
		const content = await this.app.vault.read(file);
		const index = content.indexOf(oldText);
		if (index < 0) return { error: "old_text was not found. Read the note again and copy the passage exactly." };
		if (content.indexOf(oldText, index + 1) >= 0) return { error: "old_text appears more than once. Include more surrounding text." };
		const line = content.slice(0, index).split("\n").length;
		if (!(await this.approve({ action: "edit", path: file.path, before: oldText, after: newText, line }))) return declined;
		let applied = true;
		await this.app.vault.process(file, (current) => {
			// The note may have changed while the user was reviewing.
			const at = current.indexOf(oldText);
			if (at < 0 || current.indexOf(oldText, at + 1) >= 0) {
				applied = false;
				return current;
			}
			return current.slice(0, at) + newText + current.slice(at + oldText.length);
		});
		return applied ? { edited: file.path } : { error: "The note changed meanwhile. Read it again and retry." };
	}

	private async append(args: JsonRecord) {
		const file = this.existingNote(asString(args.path) ?? "");
		const text = typeof args.content === "string" ? args.content : "";
		if (!text) return { error: "content is required." };
		if (!(await this.approve({ action: "append", path: file.path, after: text }))) return declined;
		await this.app.vault.process(file, (current) => `${current}${current.endsWith("\n") || !current ? "" : "\n"}${text}`);
		return { appended: file.path };
	}

	private async checkPrism(args: JsonRecord) {
		const file = this.existingNote(asString(args.path) ?? "");
		if (!(await this.app.vault.adapter.exists(`${this.app.vault.configDir}/plugins/prism-viz/manifest.json`))) {
			return { error: "Prism is not installed in this vault." };
		}
		const content = await this.app.vault.cachedRead(file);
		const blockCount = (content.match(/^(`{3,}|~{3,})viz\b/gm) ?? []).length;
		if (!blockCount) return { path: file.path, viz_blocks: 0 };

		const started = Date.now() - 1000;
		const open = this.app.workspace
			.getLeavesOfType("markdown")
			.find((leaf) => leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path);
		// Prism renders only visible blocks, so the note must be in a visible tab.
		const leaf = open ?? this.app.workspace.getLeaf("tab");
		if (!open) await leaf.openFile(file);
		await this.app.workspace.revealLeaf(leaf);

		const fresh = (time: string | undefined) => !!time && Date.parse(time) >= started;
		let blocks: JsonRecord[] = [];
		let errors: JsonRecord[] = [];
		for (const deadline = Date.now() + PRISM_WAIT; Date.now() < deadline; ) {
			await new Promise((resolve) => window.setTimeout(resolve, 700));
			if (!(await this.app.vault.adapter.exists(PRISM_ERRORS))) continue;
			const log = asRecord(parseJson(await this.app.vault.adapter.read(PRISM_ERRORS)));
			blocks = Object.values(asRecord(log?.blocks) ?? {})
				.map(asRecord)
				.filter((b): b is JsonRecord => !!b && b.notePath === file.path && fresh(asString(b.renderedAt)));
			errors = (Array.isArray(log?.errors) ? log.errors : [])
				.map(asRecord)
				.filter((e): e is JsonRecord => !!e && e.notePath === file.path && fresh(asString(e.time)));
			if (blocks.length >= blockCount && blocks.every((b) => b.status !== "rendering")) break;
		}
		const failed = blocks.some((b) => b.status === "error") || errors.length > 0;
		return {
			path: file.path,
			result: failed ? "errors" : blocks.length < blockCount ? "not all blocks rendered" : "all blocks rendered without errors",
			viz_blocks: blockCount,
			checked: blocks.length,
			blocks: blocks.map((b) => ({ index: b.blockIndex, title: b.title, lines: b.lines, status: b.status, errors: b.errors, warnings: b.warnings })),
			errors: errors.slice(0, 20).map((e) => ({ index: e.blockIndex, line: e.line, kind: e.kind, message: e.message })),
			...(blocks.length < blockCount
				? { note: "Some blocks did not render yet. Prism renders blocks when they are visible; ask the user to scroll through the note, then check again." }
				: {}),
		};
	}

	private async approve(change: Parameters<typeof confirmChange>[1]): Promise<boolean> {
		return !this.settings().confirmChanges || confirmChange(this.app, change);
	}

	/** Normalized vault path for a new note; refuses hidden and configuration paths. */
	private writablePath(raw: string): string {
		const path = normalizePath(raw.trim().replace(/^\/+/, ""));
		if (!path.endsWith(".md")) throw new Error("Only Markdown notes (.md) can be written.");
		if (path.split("/").some((part) => part.startsWith(".")) || path.startsWith(`${this.app.vault.configDir}/`)) {
			throw new Error("Hidden and configuration paths cannot be written.");
		}
		return path;
	}

	private existingNote(raw: string): TFile {
		const file = this.resolve(raw);
		if (!file) throw new Error("Note not found. Use search_notes or list_folder to find the right path.");
		this.writablePath(file.path);
		return file;
	}

	private resolve(path: string): TFile | null {
		const clean = path.trim().replace(/^\/+/, "");
		if (!clean) return null;
		let decoded = clean;
		try {
			decoded = decodeURIComponent(clean);
		} catch {
			// Not URL-encoded.
		}
		for (const candidate of [clean, decoded, `${decoded}.md`]) {
			const file = this.app.vault.getFileByPath(candidate);
			if (file) return file;
		}
		return this.app.metadataCache.getFirstLinkpathDest(decoded.replace(/\.md$/, ""), "");
	}

	private summary(file: TFile) {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const pick = (key: string) => {
			const value: unknown = frontmatter?.[key];
			return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
		};
		return {
			title: pick("title") ?? file.basename,
			...(pick("description") ? { description: pick("description") } : {}),
			...(pick("type") ? { type: pick("type") } : {}),
			modified: new Date(file.stat.mtime).toISOString().slice(0, 10),
		};
	}
}

const declined = { declined: true, message: "The user rejected this change. Do not retry it unchanged; ask what to do instead." };

function snippets(content: string, match: SearchResult | null): string[] {
	if (!match) return [content.slice(0, SNIPPET_RADIUS * 2).replace(/\s+/g, " ").trim()];
	const out: string[] = [];
	let lastEnd = -1;
	for (const [start, end] of match.matches) {
		if (start < lastEnd) continue;
		const from = Math.max(start - SNIPPET_RADIUS, 0);
		lastEnd = Math.min(end + SNIPPET_RADIUS, content.length);
		out.push(`${from > 0 ? "…" : ""}${content.slice(from, lastEnd).replace(/\s+/g, " ").trim()}${lastEnd < content.length ? "…" : ""}`);
		if (out.length === 3) break;
	}
	return out;
}
