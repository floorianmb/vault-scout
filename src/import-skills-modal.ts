import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { ImportableSkill, SkillLibrary } from "./skills";

/** Desktop: pick skills installed for Claude Code or Codex and copy them into the vault. */
export class ImportSkillsModal extends Modal {
	private selected = new Set<ImportableSkill>();

	constructor(app: App, private skills: SkillLibrary, private onDone?: () => void) {
		super(app);
	}

	override async onOpen(): Promise<void> {
		const { contentEl } = this;
		this.setTitle("Import skills");
		const found = await this.skills.findInstalled();
		if (!found.length) {
			contentEl.createEl("p", { text: "No skills found in the Claude Code or Codex configuration folders." });
			return;
		}
		contentEl.createEl("p", {
			text: "The Markdown files are copied into the skills folder and sync to your other devices. Scripts stay behind; the agent cannot run them.",
		});
		const existing = new Set(this.skills.list().map((skill) => skill.name));
		for (const skill of found) {
			new Setting(contentEl)
				.setName(existing.has(skill.name) ? `${skill.name} (update)` : skill.name)
				.setDesc(`${skill.source} · ${skill.files.length} file${skill.files.length === 1 ? "" : "s"} · ${skill.description}`)
				.addToggle((toggle) =>
					toggle.onChange((on) => {
						if (on) this.selected.add(skill);
						else this.selected.delete(skill);
					}),
				);
		}
		const buttons = contentEl.createDiv({ cls: "vault-scout-modal-buttons" });
		const run = new ButtonComponent(buttons).setButtonText("Import").setCta();
		run.onClick(async () => {
			if (!this.selected.size) return;
			run.setDisabled(true);
			try {
				for (const skill of this.selected) await this.skills.import(skill);
				new Notice(`Imported ${[...this.selected].map((skill) => skill.name).join(", ")}.`);
				this.close();
			} catch (error) {
				new Notice(error instanceof Error ? error.message : String(error));
				run.setDisabled(false);
			}
		});
	}

	override onClose(): void {
		this.contentEl.empty();
		this.onDone?.();
	}
}
