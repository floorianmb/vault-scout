import { App, normalizePath, Platform, requestUrl, TFile, TFolder } from "obsidian";
import { asRecord, asString, parseJson } from "./json";

export interface SkillInfo {
	name: string;
	description: string;
	enabled: boolean;
	folder: TFolder;
	file: TFile;
}

export interface ImportableSkill {
	name: string;
	description: string;
	/** Absolute folder on disk. */
	dir: string;
	/** Markdown files relative to `dir`. */
	files: string[];
	source: string;
}

const TEXT_EXTENSIONS = new Set(["md", "txt", "json", "yml", "yaml", "csv"]);
const MAX_SKILL_FILES = 40;

/** Where a skill was installed from, so it can be updated. Kept in the plugin settings, which sync. */
export type SkillSource = { type: "github"; url: string } | { type: "local"; dir: string };

export interface SkillState {
	disabled: () => string[];
	sources: () => Record<string, SkillSource>;
	/** Persists a changed source (undefined removes it). */
	setSource: (name: string, source: SkillSource | undefined) => Promise<void>;
}

/** Skills offered for one-tap installation. They load from GitHub, so this works on mobile too. */
export const SKILL_CATALOG = [
	{
		name: "prism",
		description: "Interactive charts, diagrams and formulas in notes with the Prism plugin.",
		source: "https://github.com/floorianmb/prism-viz/tree/main/skill",
	},
	{
		name: "okf-notes",
		description: "Notes that follow the Open Knowledge Format (OKF 0.2) and the vault's own conventions.",
		source: "https://github.com/floorianmb/vault-scout/tree/main/skills/okf-notes",
	},
];

interface GitHubSource {
	owner: string;
	repo: string;
	ref?: string;
	path: string;
}

/** Accepts github.com/owner/repo[/tree/ref/path] or owner/repo[/path]. */
export function parseGitHubSource(source: string): GitHubSource {
	const text = source.trim().replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\/+$/, "");
	const [owner, repo, ...rest] = text.split("/");
	if (!owner || !repo) throw new Error("Enter a GitHub folder, for example github.com/owner/repo/tree/main/skill.");
	if (rest[0] === "tree" || rest[0] === "blob") return { owner, repo: repo.replace(/\.git$/, ""), ref: rest[1], path: rest.slice(2).join("/") };
	return { owner, repo: repo.replace(/\.git$/, ""), path: rest.join("/") };
}

/**
 * Appended to every loaded skill. Skills are written for terminal agents;
 * inside Obsidian there is no shell, so script steps must be mapped to tools.
 */
const ADAPTER = `---
Note from Vault Scout: you are running inside Obsidian, not in a terminal. You cannot run shell commands or scripts (node, ruby, python, git, npm …). Map the skill's steps to your tools instead:
- Reading and searching files: search_notes, read_note, list_folder, get_links. Writing: create_note, edit_note, append_to_note.
- Paths: use vault-relative paths. An absolute path into the vault refers to the vault itself.
- Prism: instead of the prism-render.mjs command, call check_prism with the note path. It opens the note so Prism renders it and returns the block statuses and errors from .prism/errors.json.
- Skip any other step that needs a script, and tell the user what you could not do.`;

/** Skills stored in the vault as <skills folder>/<name>/SKILL.md (synced like notes). */
export class SkillLibrary {
	constructor(private app: App, private folder: () => string, private state: SkillState) {}

	sourceOf(name: string): SkillSource | undefined {
		return this.state.sources()[name];
	}

	/** Enabled skills, the only ones the agent sees. */
	enabled(): SkillInfo[] {
		return this.list().filter((skill) => skill.enabled);
	}

	/** All installed skills, including disabled ones. */
	list(): SkillInfo[] {
		const root = this.app.vault.getFolderByPath(normalizePath(this.folder()));
		if (!root) return [];
		const skills: SkillInfo[] = [];
		for (const child of root.children) {
			if (!(child instanceof TFolder)) continue;
			const file = this.app.vault.getFileByPath(`${child.path}/SKILL.md`);
			if (!file) continue;
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const name: unknown = frontmatter?.name;
			const description: unknown = frontmatter?.description;
			const skillName = typeof name === "string" && name ? name : child.name;
			skills.push({
				name: skillName,
				description: typeof description === "string" ? description : "",
				enabled: !this.state.disabled().includes(skillName),
				folder: child,
				file,
			});
		}
		return skills.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** An enabled skill by name. */
	get(name: string): SkillInfo | undefined {
		return this.enabled().find((skill) => skill.name === name || skill.folder.name === name);
	}

	/** Reinstalls a skill from where it came from. */
	async update(name: string): Promise<void> {
		const source = this.sourceOf(name);
		if (!source) throw new Error(`No source is known for ${name}; install it again.`);
		if (source.type === "github") {
			await this.installFromGitHub(source.url);
			return;
		}
		if (!Platform.isDesktop) throw new Error(`${name} was imported from a computer; update it there.`);
		const found = (await this.findInstalled()).find((skill) => skill.dir === source.dir);
		if (!found) throw new Error(`${source.dir} no longer contains the skill.`);
		await this.import(found);
	}

	/** Moves a skill folder to the trash (recoverable) and forgets its source. */
	async remove(name: string): Promise<void> {
		const skill = this.list().find((s) => s.name === name);
		if (skill) await this.app.fileManager.trashFile(skill.folder);
		await this.state.setSource(name, undefined);
	}

	/**
	 * SKILL.md without frontmatter, the list of its other files, the vault files
	 * named in its `vault-scout-context` frontmatter, and the Obsidian adapter note.
	 */
	async load(name: string): Promise<{ name: string; instructions: string; files: string[] } | undefined> {
		const skill = this.get(name);
		if (!skill) return undefined;
		const content = await this.app.vault.cachedRead(skill.file);
		const cache = this.app.metadataCache.getFileCache(skill.file);
		const end = cache?.frontmatterPosition?.end.offset;
		const contextPaths: unknown = cache?.frontmatter?.["vault-scout-context"];
		const context: string[] = [];
		for (const path of Array.isArray(contextPaths) ? contextPaths : []) {
			const file = typeof path === "string" ? this.app.vault.getFileByPath(normalizePath(path)) : null;
			if (file) context.push(`--- Context file: ${file.path} (already loaded, do not read it again) ---\n${await this.app.vault.cachedRead(file)}`);
		}
		const files: string[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) walk(child);
				else if (child !== skill.file) files.push(child.path.slice(skill.folder.path.length + 1));
			}
		};
		walk(skill.folder);
		const files_ = files.sort();
		const parts = [
			(end ? content.slice(end) : content).trim(),
			...(files_.length ? [`Further files of this skill (read_skill_file): ${files_.join(", ")}`] : []),
			...context,
			ADAPTER,
		];
		return { name: skill.name, instructions: parts.join("\n\n"), files: files_ };
	}

	async readFile(name: string, relative: string): Promise<string | undefined> {
		const skill = this.get(name);
		if (!skill) return undefined;
		const path = normalizePath(`${skill.folder.path}/${relative}`);
		if (!path.startsWith(`${skill.folder.path}/`)) return undefined;
		const file = this.app.vault.getFileByPath(path);
		return file && TEXT_EXTENSIONS.has(file.extension) ? this.app.vault.cachedRead(file) : undefined;
	}

	/** Desktop only: skills installed for Claude Code and Codex on this computer. */
	async findInstalled(): Promise<ImportableSkill[]> {
		if (!Platform.isDesktop) return [];
		const fs = await import("fs");
		const path = await import("path");
		const os = await import("os");
		const { env } = await import("process");
		const home = os.homedir();
		const roots: [string, string][] = [
			[env.CLAUDE_CONFIG_DIR ?? "", "Claude Code"],
			[path.join(home, ".claude-sso"), "Claude Code"],
			[path.join(home, ".claude"), "Claude Code"],
			[path.join(home, ".codex"), "Codex"],
		];
		const found = new Map<string, ImportableSkill & { mtime: number }>();
		for (const [root, source] of roots) {
			const dir = root && path.join(root, "skills");
			if (!dir || !fs.existsSync(dir)) continue;
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const skillDir = path.join(dir, entry.name);
				const skillFile = path.join(skillDir, "SKILL.md");
				if (!entry.isDirectory() || !fs.existsSync(skillFile)) continue;
				const text = fs.readFileSync(skillFile, "utf8");
				const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? entry.name;
				const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
				const mtime = fs.statSync(skillFile).mtimeMs;
				const previous = found.get(name);
				if (previous && previous.mtime >= mtime) continue;
				const files: string[] = [];
				const walk = (folder: string) => {
					for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
						if (item.name.startsWith(".")) continue;
						const full = path.join(folder, item.name);
						if (item.isDirectory()) walk(full);
						else if (item.name.endsWith(".md")) files.push(path.relative(skillDir, full));
					}
				};
				walk(skillDir);
				found.set(name, { name, description, dir: skillDir, files, source, mtime });
			}
		}
		return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Installs a skill from a GitHub folder that contains a SKILL.md. Works on
	 * all platforms. The installer placeholder {{VAULT}} becomes the vault root.
	 * Returns the skill's name.
	 */
	async installFromGitHub(source: string): Promise<string> {
		const files = await listGitHub(parseGitHubSource(source));
		if (!files.some((file) => file.path === "SKILL.md")) throw new Error("This folder contains no SKILL.md.");
		const contents = new Map<string, string>();
		for (const file of files) {
			const response = await requestUrl({ url: file.url, throw: false });
			if (response.status !== 200) throw new Error(`${file.path} could not be downloaded (status ${response.status}).`);
			contents.set(file.path, response.text.split("{{VAULT}}").join("."));
		}
		const skill = contents.get("SKILL.md") ?? "";
		const name = /^name:\s*(.+)$/m.exec(skill)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? parseGitHubSource(source).path.split("/").pop() ?? "skill";
		if (!/^[\w.-]+$/.test(name)) throw new Error(`The skill name "${name}" cannot be used as a folder name.`);
		await this.write(name, contents);
		await this.state.setSource(name, { type: "github", url: source.trim() });
		return name;
	}

	private async write(name: string, contents: Map<string, string>) {
		const target = normalizePath(`${this.folder()}/${name}`);
		for (const [relative, content] of contents) {
			const file = normalizePath(`${target}/${relative}`);
			if (!file.startsWith(`${target}/`)) continue;
			await ensureFolder(this.app, file.slice(0, file.lastIndexOf("/")));
			const existing = this.app.vault.getFileByPath(file);
			if (existing) await this.app.vault.modify(existing, content);
			else await this.app.vault.create(file, content);
		}
	}

	/** Copies a skill's Markdown files into the vault, replacing an earlier import. Scripts are not copied. */
	async import(skill: ImportableSkill): Promise<void> {
		if (!Platform.isDesktop) throw new Error("Importing skills needs the desktop app.");
		const fs = await import("fs");
		const path = await import("path");
		const contents = new Map<string, string>();
		for (const relative of skill.files) {
			contents.set(relative.split(path.sep).join("/"), fs.readFileSync(path.join(skill.dir, relative), "utf8"));
		}
		await this.write(skill.name, contents);
		await this.state.setSource(skill.name, { type: "local", dir: skill.dir });
	}
}

/** Files of a GitHub folder (recursive), as paths relative to it with their download URLs. */
async function listGitHub(source: GitHubSource): Promise<{ path: string; url: string }[]> {
	const out: { path: string; url: string }[] = [];
	const walk = async (path: string, depth: number) => {
		const query = source.ref ? `?ref=${encodeURIComponent(source.ref)}` : "";
		const url = `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}${query}`;
		const response = await requestUrl({ url, headers: { Accept: "application/vnd.github+json" }, throw: false });
		const entries = parseJson(response.text);
		if (response.status !== 200 || !Array.isArray(entries)) {
			throw new Error(response.status === 404 ? "GitHub folder not found." : `GitHub answered with status ${response.status}.`);
		}
		for (const raw of entries) {
			const entry = asRecord(raw);
			const entryPath = asString(entry?.path) ?? "";
			const relative = source.path ? entryPath.slice(source.path.length + 1) : entryPath;
			if (entry?.type === "dir" && depth < 3) await walk(entryPath, depth + 1);
			const download = asString(entry?.download_url);
			if (entry?.type === "file" && download && TEXT_EXTENSIONS.has(relative.split(".").pop() ?? "")) out.push({ path: relative, url: download });
			if (out.length > MAX_SKILL_FILES) throw new Error(`The folder has more than ${MAX_SKILL_FILES} files; this does not look like a single skill.`);
		}
	};
	await walk(source.path, 0);
	return out;
}

export async function ensureFolder(app: App, folder: string): Promise<void> {
	let current = "";
	for (const part of normalizePath(folder).split("/").filter(Boolean)) {
		current = current ? `${current}/${part}` : part;
		if (!app.vault.getFolderByPath(current)) await app.vault.createFolder(current);
	}
}
