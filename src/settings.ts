import { App, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import type VaultScoutPlugin from "./main";
import { SignInModal } from "./sign-in-modal";

export interface VaultScoutSettings {
	model: string;
	extraInstructions: string;
}

export const DEFAULT_SETTINGS: VaultScoutSettings = {
	model: "",
	extraInstructions: "",
};

export class VaultScoutSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: VaultScoutPlugin) {
		super(app, plugin);
	}

	override getSettingDefinitions(): SettingDefinitionItem[] {
		const connection = this.plugin.auth.connection;
		const models = this.plugin.models;
		const options: Record<string, string> = {};
		for (const model of models) options[model.slug] = model.displayName;
		if (this.plugin.settings.model && !options[this.plugin.settings.model]) {
			options[this.plugin.settings.model] = this.plugin.settings.model;
		}

		return [
			{
				type: "group",
				heading: "ChatGPT account",
				items: [
					{
						name: connection ? `Connected as ${connection.email ?? connection.name ?? "ChatGPT user"}` : "Not connected",
						desc: "Requests use your ChatGPT Plus or Pro plan. The sign-in is stored on this device only and is not synced.",
						render: (setting) => {
							setting.addButton((button) => {
								if (connection) {
									button.setButtonText("Sign out").onClick(async () => {
										await this.plugin.auth.signOut();
										this.update();
									});
								} else {
									button.setButtonText("Sign in with ChatGPT").setCta().onClick(() => {
										new SignInModal(this.app, this.plugin.auth, () => {
											void this.plugin.loadModels().finally(() => this.update());
										}).open();
									});
								}
							});
						},
					},
				],
			},
			{
				type: "group",
				heading: "Research",
				items: [
					{
						name: "Model",
						desc: models.length ? "Models available to your account." : "Sign in to load the available models.",
						control: { type: "dropdown", key: "model", options },
					},
					{
						name: "Extra instructions",
						desc: "Added to every conversation, for example preferred language or citation style.",
						control: { type: "textarea", key: "extraInstructions", rows: 4 },
					},
				],
			},
		];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		if ((key === "model" || key === "extraInstructions") && typeof value === "string") {
			this.plugin.settings[key] = value;
			await this.plugin.saveSettings();
		}
	}
}
