import { App, ButtonComponent, Modal, TextComponent } from "obsidian";

/**
 * The agent's question to the user (ask_user), with optional suggested answers
 * and a free-text field. Resolves with the answer, or null when dismissed.
 * Idea from Chatting with AI (github.com/o1xhack/obsidian-chatting).
 */
export function askUser(app: App, question: string, options: string[]): Promise<string | null> {
	return new Promise((resolve) => new AskModal(app, question, options, resolve).open());
}

class AskModal extends Modal {
	private answered = false;

	constructor(app: App, private question: string, private options: string[], private resolve: (answer: string | null) => void) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Vault Scout asks");
		contentEl.addClass("vault-scout-ask");
		contentEl.createEl("p", { text: this.question });

		if (this.options.length) {
			const choices = contentEl.createDiv({ cls: "vault-scout-ask-options" });
			for (const option of this.options) new ButtonComponent(choices).setButtonText(option).onClick(() => this.answer(option));
		}

		const row = contentEl.createDiv({ cls: "vault-scout-ask-row" });
		const input = new TextComponent(row).setPlaceholder(this.options.length ? "Or type an answer" : "Your answer");
		input.inputEl.setAttrs({ enterkeyhint: "send" });
		this.scope.register([], "Enter", (evt) => {
			if (evt.target !== input.inputEl) return;
			evt.preventDefault();
			if (input.getValue().trim()) this.answer(input.getValue().trim());
			return false;
		});
		new ButtonComponent(row).setButtonText("Send").setCta().onClick(() => {
			if (input.getValue().trim()) this.answer(input.getValue().trim());
		});
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.answered) this.resolve(null);
	}

	private answer(text: string) {
		this.answered = true;
		this.resolve(text);
		this.close();
	}
}
