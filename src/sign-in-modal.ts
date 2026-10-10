import { App, ButtonComponent, Modal, Notice, Platform, TextComponent } from "obsidian";
import { ChatGPTAuth } from "./auth";

/**
 * Sign in with ChatGPT by pasting the callback address. OpenAI redirects to a
 * 127.0.0.1 listener, which a plugin cannot run on mobile, so the browser
 * shows a connection error whose address holds the sign-in code.
 */
export class SignInModal extends Modal {
	private input!: TextComponent;
	private errorEl!: HTMLElement;
	private connectButton!: ButtonComponent;
	private connecting = false;

	constructor(app: App, private auth: ChatGPTAuth, private onDone?: () => void) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl } = this;
		this.setTitle("Sign in with ChatGPT");
		contentEl.addClass("vault-scout-sign-in");
		this.errorEl = createDiv({ cls: "vault-scout-error" });

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

		// The URL is prepared up front: opening it after an await is no longer a
		// direct reaction to the tap, and the app blocks it like a pop-up.
		let url: string | undefined;
		const buttons = contentEl.createDiv({ cls: "vault-scout-modal-buttons is-start" });
		const open = new ButtonComponent(buttons).setButtonText("Open sign-in page").setCta().setDisabled(true);
		const copy = new ButtonComponent(buttons).setButtonText("Copy link").setDisabled(true);
		open.onClick(() => {
			if (url) window.open(url);
		});
		copy.onClick(async () => {
			if (!url) return;
			try {
				await navigator.clipboard.writeText(url);
				new Notice("Sign-in link copied. Open it in your browser.");
			} catch {
				new Notice("Clipboard is not available.");
			}
		});
		this.auth
			.startSignIn()
			.then((prepared) => {
				url = prepared;
				open.setDisabled(false);
				copy.setDisabled(false);
			})
			.catch((error: unknown) => this.showError(error));

		// A single-line field: on iOS a textarea's keyboard has no key that closes it.
		this.input = new TextComponent(contentEl).setPlaceholder("Paste the full address here");
		const field = this.input.inputEl;
		field.addClass("vault-scout-callback-input");
		field.setAttrs({ enterkeyhint: "go", inputmode: "url", autocapitalize: "off", autocorrect: "off", spellcheck: "false" });
		this.input.onChange((value) => {
			// A complete callback address connects right away and closes the keyboard.
			if (/[?&]code=/.test(value) && /[?&]state=/.test(value)) void this.connect();
		});
		this.scope.register([], "Enter", (evt) => {
			if (evt.target !== field) return;
			evt.preventDefault();
			void this.connect();
			return false;
		});
		// Tapping anywhere else in the dialog closes the keyboard.
		this.registerDismiss(contentEl, field);

		const actions = contentEl.createDiv({ cls: "vault-scout-modal-buttons" });
		new ButtonComponent(actions).setButtonText("Paste").onClick(async () => {
			try {
				this.input.setValue(await navigator.clipboard.readText());
				void this.connect();
			} catch {
				new Notice("Clipboard is not available. Paste the address manually.");
			}
		});
		this.connectButton = new ButtonComponent(actions).setButtonText("Connect").setCta();
		this.connectButton.onClick(() => void this.connect());

		contentEl.appendChild(this.errorEl);
	}

	override onClose(): void {
		this.contentEl.empty();
		this.onDone?.();
	}

	private registerDismiss(container: HTMLElement, field: HTMLInputElement) {
		container.addEventListener("pointerdown", (evt) => {
			const target = evt.target;
			if (target instanceof HTMLElement && target !== field && !target.closest("button")) field.blur();
		});
	}

	private async connect() {
		const value = this.input.getValue().trim();
		if (!value || this.connecting) return;
		this.connecting = true;
		this.input.inputEl.blur();
		this.connectButton.setDisabled(true);
		this.errorEl.empty();
		try {
			const connection = await this.auth.completeSignIn(value);
			new Notice(`Connected as ${connection.email ?? connection.name ?? "ChatGPT user"}.`);
			this.close();
		} catch (error) {
			this.showError(error);
		} finally {
			this.connecting = false;
			this.connectButton.setDisabled(false);
		}
	}

	private showError(error: unknown) {
		this.errorEl.setText(error instanceof Error ? error.message : String(error));
	}
}
