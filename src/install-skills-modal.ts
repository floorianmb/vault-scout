import { App, ButtonComponent, Modal, Notice, Platform, Setting, TextComponent } from "obsidian";
import { ImportSkillsModal } from "./import-skills-modal";
import { SKILL_CATALOG, SkillLibrary } from "./skills";

/** Install skills from GitHub (all platforms) or, on desktop, from Claude Code and Codex. */
export class InstallSkillsModal extends Modal {
	constructor(app: App, private skills: SkillLibrary, private onDone?: () => void) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Install skills");
		const installed = new Set(this.skills.list().map((skill) => skill.name));

		for (const entry of SKILL_CATALOG) {
			new Setting(contentEl)
				.setName(entry.name)
				.setDesc(entry.description)
				.addButton((button) =>
					button
						.setButtonText(installed.has(entry.name) ? "Update" : "Install")
						.setCta()
						.onClick(() => this.install(button, entry.source)),
				);
		}

		let url: TextComponent | undefined;
		new Setting(contentEl)
			.setName("From GitHub")
			.setDesc("A GitHub folder that contains a SKILL.md, for example github.com/owner/repo/tree/main/skills/name.")
			.addText((text) => (url = text.setPlaceholder("Paste a GitHub folder link")))
			.addButton((button) => button.setButtonText("Install").onClick(() => this.install(button, url?.getValue() ?? "")));

		if (Platform.isDesktop) {
			new Setting(contentEl)
				.setName("From Claude Code and Codex")
				.setDesc("Skills installed on this computer.")
				.addButton((button) =>
					button.setButtonText("Choose").onClick(() => {
						this.close();
						new ImportSkillsModal(this.app, this.skills, this.onDone).open();
					}),
				);
		}
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Skills are saved in the skills folder and sync to your other devices. Only text files are installed; scripts are not.",
		});
	}

	override onClose(): void {
		this.contentEl.empty();
		this.onDone?.();
	}

	private async install(button: ButtonComponent, source: string) {
		if (!source.trim()) return;
		button.setDisabled(true);
		try {
			const name = await this.skills.installFromGitHub(source);
			new Notice(`Installed skill ${name}.`);
			this.close();
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
			button.setDisabled(false);
		}
	}
}
