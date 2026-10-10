import { Editor, MarkdownFileInfo, Platform, Plugin } from "obsidian";
import { ChatGPTAuth } from "./auth";
import { ChatStore } from "./chats";
import { InstallSkillsModal } from "./install-skills-modal";
import { listModels, ModelInfo } from "./openai";
import { DEFAULT_SETTINGS, VaultScoutSettings, VaultScoutSettingTab } from "./settings";
import { SignInModal } from "./sign-in-modal";
import { SkillLibrary } from "./skills";
import { VaultTools } from "./tools";
import { ChatView, VIEW_TYPE_CHAT } from "./view";

export default class VaultScoutPlugin extends Plugin {
	override settings: VaultScoutSettings = { ...DEFAULT_SETTINGS };
	auth!: ChatGPTAuth;
	tools!: VaultTools;
	chats!: ChatStore;
	skills!: SkillLibrary;
	models: ModelInfo[] = [];

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.auth = new ChatGPTAuth(this.app);
		this.chats = new ChatStore(this.app, () => this.settings.chatFolder || DEFAULT_SETTINGS.chatFolder);
		this.skills = new SkillLibrary(this.app, () => this.settings.skillsFolder || DEFAULT_SETTINGS.skillsFolder, {
			disabled: () => this.settings.disabledSkills,
			sources: () => this.settings.skillSources,
			setSource: async (name, source) => {
				const sources = { ...this.settings.skillSources };
				if (source) sources[name] = source;
				else delete sources[name];
				this.settings.skillSources = sources;
				await this.saveSettings();
			},
		});
		this.tools = new VaultTools(this.app, () => this.settings, this.skills);
		this.register(this.auth.onChange(() => {
			if (!this.auth.connection) this.models = [];
		}));

		this.registerView(VIEW_TYPE_CHAT, (leaf) => new ChatView(leaf, this));
		this.addRibbonIcon("telescope", "Open Vault Scout", () => void this.openChat());
		this.addCommand({ id: "open-chat", name: "Open chat", callback: () => void this.openChat() });
		this.addCommand({
			id: "sign-in",
			name: "Sign in with ChatGPT",
			callback: () => new SignInModal(this.app, this.auth).open(),
		});
		this.addCommand({
			id: "open-chat-list",
			name: "Open a saved chat",
			callback: async () => (await this.openChat())?.pickChat(),
		});
		this.addCommand({
			id: "ask-about-selection",
			name: "Ask about the selection",
			editorCheckCallback: (checking, editor, info) => {
				if (!editor.somethingSelected() || !info.file) return false;
				if (!checking) void this.askAboutSelection(editor, info);
				return true;
			},
		});
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, info) => {
				if (!editor.somethingSelected() || !info.file) return;
				menu.addItem((item) =>
					item.setTitle("Ask Vault Scout about selection").setIcon("telescope").onClick(() => void this.askAboutSelection(editor, info)),
				);
			}),
		);
		this.addCommand({
			id: "install-skills",
			name: "Install skills",
			callback: () => new InstallSkillsModal(this.app, this.skills).open(),
		});
		this.addSettingTab(new VaultScoutSettingTab(this.app, this));
	}

	/** Opens the chat with the editor's selection as the scope of the next question. Idea from Chatting with AI. */
	private async askAboutSelection(editor: Editor, info: MarkdownFileInfo) {
		const from = editor.getCursor("from").line + 1;
		const to = editor.getCursor("to").line + 1;
		const selection = { path: info.file?.path ?? "", text: editor.getSelection(), fromLine: from, toLine: to };
		(await this.openChat())?.setSelection(selection);
	}

	async loadModels(): Promise<ModelInfo[]> {
		if (!this.models.length && this.auth.connection) {
			this.models = await listModels(await this.auth.accessToken());
		}
		return this.models;
	}

	async loadSettings(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<VaultScoutSettings> | null) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	async openChat(): Promise<ChatView | undefined> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
		// On phones and tablets a sidebar drawer is hard to find and cramped for typing; use a tab.
		const leaf = existing ?? (Platform.isMobile ? this.app.workspace.getLeaf("tab") : this.app.workspace.getRightLeaf(false));
		if (!leaf) return undefined;
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
		await this.app.workspace.revealLeaf(leaf);
		return leaf.view instanceof ChatView ? leaf.view : undefined;
	}
}
