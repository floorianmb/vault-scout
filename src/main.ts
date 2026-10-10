import { Plugin } from "obsidian";
import { ChatGPTAuth } from "./auth";
import { listModels, ModelInfo } from "./openai";
import { DEFAULT_SETTINGS, VaultScoutSettings, VaultScoutSettingTab } from "./settings";
import { SignInModal } from "./sign-in-modal";
import { VaultTools } from "./tools";
import { ChatView, VIEW_TYPE_CHAT } from "./view";

export default class VaultScoutPlugin extends Plugin {
	override settings: VaultScoutSettings = { ...DEFAULT_SETTINGS };
	auth!: ChatGPTAuth;
	tools!: VaultTools;
	models: ModelInfo[] = [];

	override async onload(): Promise<void> {
		await this.loadSettings();
		this.auth = new ChatGPTAuth(this.app);
		this.tools = new VaultTools(this.app);
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
		this.addSettingTab(new VaultScoutSettingTab(this.app, this));
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

	private async openChat() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}
}
