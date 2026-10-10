import { ButtonComponent, Component, DropdownComponent, ItemView, Keymap, MarkdownRenderer, Platform, setIcon, WorkspaceLeaf } from "obsidian";
import { Agent } from "./agent";
import { AuthError } from "./auth";
import type VaultScoutPlugin from "./main";
import { ApiError } from "./openai";
import { SignInModal } from "./sign-in-modal";
import { ToolCall } from "./tools";

export const VIEW_TYPE_CHAT = "vault-scout-chat";

const ERROR_HINTS: Record<string, string> = {
	subscription_sharing_usage_limit_exceeded:
		"The weekly limit for Vault Scout is reached. Raise it in ChatGPT settings or wait for the reset.",
	subscription_sharing_user_not_eligible: "Using your plan in other apps needs ChatGPT Plus or Pro.",
	subscription_sharing_usage_unavailable: "Plan usage is temporarily unavailable. Try again shortly.",
	subscription_sharing_invalid_user: "The connection was removed in ChatGPT. Sign in again.",
	invalid_grant: "The ChatGPT connection expired. Sign in again.",
};

function describe(error: unknown): string {
	if (error instanceof DOMException && error.name === "AbortError") return "Stopped.";
	if (error instanceof ApiError || error instanceof AuthError) return ERROR_HINTS[error.code] ?? error.message;
	return error instanceof Error ? error.message : String(error);
}

function toolLabel(call: ToolCall): string {
	const arg = (key: string) => (typeof call.args[key] === "string" ? call.args[key] : "");
	switch (call.name) {
		case "search_notes":
			return `Searching “${arg("query")}”`;
		case "read_note":
			return `Reading ${arg("path")}`;
		case "list_folder":
			return `Listing ${arg("path") || "vault root"}`;
		case "get_links":
			return `Following links of ${arg("path")}`;
		default:
			return call.name;
	}
}

export class ChatView extends ItemView {
	private agent: Agent;
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendButton!: ButtonComponent;
	private modelDropdown!: DropdownComponent;
	private accountEl!: HTMLElement;
	private messageComponents: Component[] = [];
	private abort: AbortController | undefined;

	constructor(leaf: WorkspaceLeaf, private plugin: VaultScoutPlugin) {
		super(leaf);
		this.agent = new Agent(plugin.auth, plugin.tools);
	}

	getViewType(): string {
		return VIEW_TYPE_CHAT;
	}

	getDisplayText(): string {
		return "Vault Scout";
	}

	override getIcon(): string {
		return "telescope";
	}

	override async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("vault-scout");

		const header = root.createDiv({ cls: "vault-scout-header" });
		this.modelDropdown = new DropdownComponent(header).onChange(async (value) => {
			this.plugin.settings.model = value;
			await this.plugin.saveSettings();
		});
		this.modelDropdown.selectEl.addClass("vault-scout-model");
		const newChat = header.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "New chat" } });
		setIcon(newChat, "square-pen");
		this.registerDomEvent(newChat, "click", () => this.newChat());

		this.accountEl = root.createDiv({ cls: "vault-scout-account" });
		this.messagesEl = root.createDiv({ cls: "vault-scout-messages" });
		this.registerDomEvent(this.messagesEl, "click", (evt) => this.openLink(evt));

		const composer = root.createDiv({ cls: "vault-scout-composer" });
		this.inputEl = composer.createEl("textarea", { attr: { placeholder: "Ask about your notes…", rows: "3" } });
		this.registerDomEvent(this.inputEl, "keydown", (evt) => {
			if (evt.key === "Enter" && !evt.shiftKey && !evt.isComposing && !Platform.isMobile) {
				evt.preventDefault();
				void this.submit();
			}
		});
		this.sendButton = new ButtonComponent(composer).setIcon("send").setCta().setTooltip("Send");
		this.sendButton.onClick(() => (this.abort ? this.abort.abort() : void this.submit()));

		this.register(this.plugin.auth.onChange(() => void this.refreshAccount()));
		await this.refreshAccount();
	}

	override async onClose(): Promise<void> {
		this.abort?.abort();
	}

	private async refreshAccount() {
		const connection = this.plugin.auth.connection;
		this.accountEl.empty();
		this.accountEl.toggleClass("is-hidden", !!connection);
		this.modelDropdown.setDisabled(!connection);
		if (!connection) {
			this.accountEl.createDiv({ text: "Connect your ChatGPT plan to research your vault." });
			new ButtonComponent(this.accountEl)
				.setButtonText("Sign in with ChatGPT")
				.setCta()
				.onClick(() => new SignInModal(this.app, this.plugin.auth).open());
			return;
		}
		try {
			const models = await this.plugin.loadModels();
			this.modelDropdown.selectEl.empty();
			for (const model of models) this.modelDropdown.addOption(model.slug, model.displayName);
			const current = models.find((m) => m.slug === this.plugin.settings.model) ?? models[0];
			if (current) {
				this.modelDropdown.setValue(current.slug);
				this.plugin.settings.model = current.slug;
			}
		} catch (error) {
			this.accountEl.removeClass("is-hidden");
			this.accountEl.createDiv({ cls: "vault-scout-error", text: describe(error) });
		}
	}

	private newChat() {
		this.abort?.abort();
		this.agent.reset();
		for (const component of this.messageComponents) this.removeChild(component);
		this.messageComponents = [];
		this.messagesEl.empty();
	}

	private async submit() {
		const text = this.inputEl.value.trim();
		if (!text || this.abort) return;
		if (!this.plugin.auth.connection) {
			new SignInModal(this.app, this.plugin.auth).open();
			return;
		}
		this.inputEl.value = "";
		this.messagesEl.createDiv({ cls: "vault-scout-message is-user", text });

		const abort = (this.abort = new AbortController());
		this.sendButton.setIcon("square").setTooltip("Stop");
		let bubble = this.messagesEl.createDiv({ cls: "vault-scout-message is-assistant is-streaming" });
		let streamed = "";
		const scroll = () => this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight });

		try {
			const incomplete = await this.agent.send(text, this.plugin.settings.model, this.plugin.settings.extraInstructions, {
				onText: (delta) => {
					streamed += delta;
					bubble.setText(streamed);
					scroll();
				},
				onTool: (call) => {
					this.messagesEl.insertBefore(createDiv({ cls: "vault-scout-tool", text: toolLabel(call) }), bubble);
					scroll();
				},
				onRoundEnd: () => {
					if (!streamed) return;
					void this.renderMarkdown(bubble, streamed);
					streamed = "";
					bubble = this.messagesEl.createDiv({ cls: "vault-scout-message is-assistant is-streaming" });
				},
			}, abort.signal);
			if (incomplete) this.messagesEl.createDiv({ cls: "vault-scout-error", text: `The answer is incomplete (${incomplete}).` });
		} catch (error) {
			if (streamed) void this.renderMarkdown(bubble, streamed);
			this.messagesEl.createDiv({ cls: "vault-scout-error", text: describe(error) });
		} finally {
			if (!bubble.hasChildNodes()) bubble.remove();
			this.abort = undefined;
			this.sendButton.setIcon("send").setTooltip("Send");
			scroll();
		}
	}

	private async renderMarkdown(el: HTMLElement, markdown: string) {
		el.empty();
		el.removeClass("is-streaming");
		const component = new Component();
		this.addChild(component);
		this.messageComponents.push(component);
		await MarkdownRenderer.render(this.app, markdown, el, "", component);
	}

	private openLink(evt: MouseEvent) {
		const target = evt.target;
		if (!(target instanceof HTMLElement)) return;
		const link = target.closest("a.internal-link");
		const href = link?.getAttribute("data-href") ?? link?.getAttribute("href");
		if (!href) return;
		evt.preventDefault();
		let path = href;
		try {
			path = decodeURIComponent(href);
		} catch {
			// Keep as is.
		}
		void this.app.workspace.openLinkText(path, "", Keymap.isModEvent(evt));
	}
}
