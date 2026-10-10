import { App, Notice, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import { InstallSkillsModal } from "./install-skills-modal";
import type VaultScoutPlugin from "./main";
import { SignInModal } from "./sign-in-modal";
import type { SkillSource } from "./skills";

export interface VaultScoutSettings {
	model: string;
	extraInstructions: string;
	chatFolder: string;
	skillsFolder: string;
	confirmChanges: boolean;
	disabledSkills: string[];
	skillSources: Record<string, SkillSource>;
}

export const DEFAULT_SETTINGS: VaultScoutSettings = {
	model: "",
	extraInstructions: "",
	chatFolder: "Vault Scout/Chats",
	skillsFolder: "Vault Scout/Skills",
	confirmChanges: true,
	disabledSkills: [],
	skillSources: {},
};

const STRING_KEYS = ["model", "extraInstructions", "chatFolder", "skillsFolder"] as const;

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
					{
						name: "Confirm changes",
						desc: "Show every note the agent creates or changes for approval before it is written.",
						control: { type: "toggle", key: "confirmChanges" },
					},
				],
			},
			{
				type: "group",
				heading: "Chats and skills",
				items: [
					{
						name: "Chat folder",
						desc: "Each chat is saved as a note here, so it syncs to your other devices.",
						control: { type: "folder", key: "chatFolder", placeholder: DEFAULT_SETTINGS.chatFolder },
					},
					{
						name: "Skills folder",
						desc: "One subfolder per skill with a SKILL.md, like skills for Claude Code and Codex.",
						control: { type: "folder", key: "skillsFolder", placeholder: DEFAULT_SETTINGS.skillsFolder },
					},
					{
						name: "Install skills",
						desc: "Install the Prism skill or any skill from GitHub. On desktop also from Claude Code and Codex.",
						action: () => new InstallSkillsModal(this.app, this.plugin.skills, () => this.update()).open(),
					},
				],
			},
			{
				type: "group",
				heading: "Installed skills",
				items: this.plugin.skills.list().length ? this.plugin.skills.list().map((skill) => ({
					name: skill.name,
					desc: skill.description,
					render: (setting) => {
						setting.addToggle((toggle) =>
							toggle
								.setTooltip(skill.enabled ? "Turn off" : "Turn on")
								.setValue(skill.enabled)
								.onChange(async (on) => {
									const disabled = new Set(this.plugin.settings.disabledSkills);
									if (on) disabled.delete(skill.name);
									else disabled.add(skill.name);
									this.plugin.settings.disabledSkills = [...disabled];
									await this.plugin.saveSettings();
								}),
						);
						if (this.plugin.skills.sourceOf(skill.name)) {
							setting.addExtraButton((button) =>
								button.setIcon("refresh-cw").setTooltip("Update").onClick(async () => {
									try {
										await this.plugin.skills.update(skill.name);
										new Notice(`Updated skill ${skill.name}.`);
									} catch (error) {
										new Notice(error instanceof Error ? error.message : String(error));
									}
									this.update();
								}),
							);
						}
						setting.addExtraButton((button) =>
							button.setIcon("trash-2").setTooltip("Remove").onClick(async () => {
								await this.plugin.skills.remove(skill.name);
								new Notice(`Moved skill ${skill.name} to the trash.`);
								this.update();
							}),
						);
					},
				})) : [{ name: "No skills installed yet." }],
			},
		];
	}

	override async setControlValue(key: string, value: unknown): Promise<void> {
		const stringKey = STRING_KEYS.find((k) => k === key);
		if (stringKey && typeof value === "string") this.plugin.settings[stringKey] = value;
		else if (key === "confirmChanges" && typeof value === "boolean") this.plugin.settings.confirmChanges = value;
		else return;
		await this.plugin.saveSettings();
	}
}
