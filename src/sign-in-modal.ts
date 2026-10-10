import { App, ButtonComponent, Modal, Notice, Platform, TextAreaComponent } from "obsidian";
import { ChatGPTAuth } from "./auth";

/**
 * Sign in with ChatGPT by pasting the callback address. OpenAI redirects to a
 * 127.0.0.1 listener, which a plugin cannot run on mobile, so the browser
 * shows a connection error whose address holds the sign-in code.
 */
export class SignInModal extends Modal {
	private input!: TextAreaComponent;
	private errorEl!: HTMLElement;

	constructor(app: App, private auth: ChatGPTAuth, private onDone?: () => void) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Sign in with ChatGPT");
		contentEl.addClass("vault-scout-sign-in");

		const steps = contentEl.createEl("ol");
		steps.createEl("li", { text: "Open the sign-in page and approve Vault Scout, including plan usage." });
		steps.createEl("li", {
			text: "The browser then shows a page that cannot be reached. That is expected: the sign-in code is in its address.",
		});
		steps.createEl("li", {
			text: Platform.isMobile
				? "Tap the address bar, copy the full address and return to Obsidian."
				: "Copy the full address from the address bar.",
		});
		steps.createEl("li", { text: "Paste it below and connect." });

		new ButtonComponent(contentEl)
			.setButtonText("Open sign-in page")
			.setCta()
			.onClick(async () => {
				try {
					window.open(await this.auth.startSignIn());
				} catch (error) {
					this.showError(error);
				}
			});

		this.input = new TextAreaComponent(contentEl).setPlaceholder("Paste the full address here");
		this.input.inputEl.addClass("vault-scout-callback-input");

		const buttons = contentEl.createDiv({ cls: "vault-scout-modal-buttons" });
		new ButtonComponent(buttons).setButtonText("Paste").onClick(async () => {
			try {
				this.input.setValue(await navigator.clipboard.readText());
			} catch {
				new Notice("Clipboard is not available. Paste the address manually.");
			}
		});
		const connect = new ButtonComponent(buttons).setButtonText("Connect").setCta();
		connect.onClick(async () => {
			connect.setDisabled(true);
			this.errorEl.empty();
			try {
				const connection = await this.auth.completeSignIn(this.input.getValue());
				new Notice(`Connected as ${connection.email ?? connection.name ?? "ChatGPT user"}.`);
				this.close();
			} catch (error) {
				this.showError(error);
			} finally {
				connect.setDisabled(false);
			}
		});

		this.errorEl = contentEl.createDiv({ cls: "vault-scout-error" });
	}

	override onClose(): void {
		this.contentEl.empty();
		this.onDone?.();
	}

	private showError(error: unknown) {
		this.errorEl.setText(error instanceof Error ? error.message : String(error));
	}
}
