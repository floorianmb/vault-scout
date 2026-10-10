import { App, getAllTags, prepareSimpleSearch, SearchResult, TFile, TFolder } from "obsidian";
import { asRecord, asString, JsonRecord, parseJson } from "./json";

const TEXT_EXTENSIONS = new Set(["md", "txt", "canvas", "base", "csv", "json"]);
const SNIPPET_RADIUS = 90;

export interface ToolCall {
	name: string;
	args: JsonRecord;
}

/** Read-only tools the model uses to research the vault. */
export class VaultTools {
	constructor(private app: App) {}

	definitions(): JsonRecord[] {
		return [
			{
				type: "function",
				name: "search_notes",
				description:
					"Full-text search over the vault's Markdown notes (title, path and content). All words must appear; " +
					"if nothing matches, notes matching most words are returned. Use a few precise keywords, try synonyms " +
					"and both German and English terms. Returns paths, frontmatter summary and matching snippets.",
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "Space-separated keywords." },
						folder: { type: "string", description: "Only search inside this folder path." },
						tag: { type: "string", description: "Only notes with this tag, without #." },
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
						path: { type: "string", description: "Vault path, e.g. 'Folder/Note.md'. A note name also works." },
						offset: { type: "integer", description: "Character offset to start from. Default 0." },
					},
					required: ["path"],
				},
			},
			{
				type: "function",
				name: "list_folder",
				description: "List the subfolders and files of a folder. Use '' for the vault root. Index notes often summarize a folder.",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "Folder path, '' for the root." } },
					required: ["path"],
				},
			},
			{
				type: "function",
				name: "get_links",
				description: "Outgoing links, unresolved links and backlinks of a note, to follow related notes.",
				parameters: {
					type: "object",
					properties: { path: { type: "string", description: "Vault path of the note." } },
					required: ["path"],
				},
			},
		];
	}

	parse(name: string, argumentsJson: string): ToolCall {
		return { name, args: asRecord(parseJson(argumentsJson)) ?? {} };
	}

	async execute(call: ToolCall): Promise<string> {
		try {
			switch (call.name) {
				case "search_notes":
					return JSON.stringify(await this.search(call.args));
				case "read_note":
					return JSON.stringify(await this.read(call.args));
				case "list_folder":
					return JSON.stringify(this.list(call.args));
				case "get_links":
					return JSON.stringify(this.links(call.args));
				default:
					return JSON.stringify({ error: `Unknown tool ${call.name}` });
			}
		} catch (error) {
			return JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
		}
	}

	private async search(args: JsonRecord) {
		const query = asString(args.query)?.trim();
		if (!query) return { error: "query is required" };
		const limit = Math.min(Math.max(typeof args.limit === "number" ? Math.round(args.limit) : 10, 1), 25);
		const folder = asString(args.folder)?.replace(/^\/+|\/+$/g, "");
		const tag = asString(args.tag)?.replace(/^#/, "").toLowerCase();

		const files = this.app.vault.getMarkdownFiles().filter((file) => {
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
