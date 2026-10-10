import { ButtonComponent, Component, DropdownComponent, ItemView, Keymap, MarkdownRenderer, Notice, Platform, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { Agent } from "./agent";
import { AuthError } from "./auth";
import { Chat, ChatPickerModal, ChatTurn } from "./chats";
import type VaultScoutPlugin from "./main";
import { ApiError, streamingUnavailableReason } from "./openai";
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
		case "create_note":
			return `Creating ${arg("path")}`;
		case "edit_note":
			return `Editing ${arg("path")}`;
		case "append_to_note":
			return `Appending to ${arg("path")}`;
		case "check_prism":
			return `Checking Prism blocks in ${arg("path")}`;
		case "load_skill":
			return `Loading skill ${arg("name")}`;
		case "read_skill_file":
			return `Reading ${arg("file")} of skill ${arg("name")}`;
		default:
			return call.name;
	}
}

export class ChatView extends ItemView {
	private agent: Agent;
	private chat: Chat;
	private titleEl!: HTMLElement;
	private messagesEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendButton!: ButtonComponent;
	private modelDropdown!: DropdownComponent;
	private accountEl!: HTMLElement;
	private noteButton!: HTMLElement;
	private messageComponents: Component[] = [];
	private abort: AbortController | undefined;
	private streamingNoteShown = false;

	constructor(leaf: WorkspaceLeaf, private plugin: VaultScoutPlugin) {
		super(leaf);
		this.agent = new Agent(plugin.auth, plugin.tools);
		this.chat = plugin.chats.newChat(plugin.settings.model);
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
		this.iconButton(header, "history", "Chats", () => this.pickChat());
		this.noteButton = this.iconButton(header, "file-text", "Open chat as note", () => {
			if (this.chat.file) void this.app.workspace.getLeaf("tab").openFile(this.chat.file);
		});
		this.iconButton(header, "square-pen", "New chat", () => this.newChat());

		this.titleEl = root.createDiv({ cls: "vault-scout-title" });
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
		this.updateHeader();
		await this.refreshAccount();
	}

	override async onClose(): Promise<void> {
		this.abort?.abort();
	}

	pickChat(): void {
		new ChatPickerModal(this.app, this.plugin.chats, (file) => void this.openChat(file)).open();
	}

	async openChat(file: TFile): Promise<void> {
		this.abort?.abort();
		this.chat = await this.plugin.chats.load(file);
		await this.agent.load(this.chat.turns, this.chat.skills);
		this.clearMessages();
		for (const turn of this.chat.turns) {
			this.messagesEl.createDiv({ cls: "vault-scout-message is-user", text: turn.user });
			if (turn.steps.length) {
				const steps = new StepList(this.messagesEl);
				for (const step of turn.steps) steps.add(step);
				steps.finish();
			}
			if (turn.answer) await this.renderMarkdown(this.messagesEl.createDiv({ cls: "vault-scout-message is-assistant" }), turn.answer);
		}
		this.updateHeader();
		this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight });
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
		const button = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(button, icon);
		this.registerDomEvent(button, "click", onClick);
		return button;
	}

	private updateHeader() {
		this.titleEl.setText(this.chat.title);
		this.titleEl.toggleClass("is-hidden", !this.chat.title);
		this.noteButton.toggleClass("is-hidden", !this.chat.file);
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
		this.chat = this.plugin.chats.newChat(this.plugin.settings.model);
		this.clearMessages();
		this.updateHeader();
	}

	private clearMessages() {
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

		const chat = this.chat;
		const turn: ChatTurn = { user: text, steps: [], answer: "" };
		chat.turns.push(turn);
		chat.model = this.plugin.settings.model;

		const abort = (this.abort = new AbortController());
		this.sendButton.setIcon("square").setTooltip("Stop");
		let bubble = this.messagesEl.createDiv({ cls: "vault-scout-message is-assistant is-streaming" });
		const steps = new StepList(this.messagesEl, bubble);
		let streamed = "";
		const scroll = () => this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight });
		const keepRound = () => {
			if (!streamed) return;
			turn.answer = turn.answer ? `${turn.answer}\n\n${streamed}` : streamed;
			void this.renderMarkdown(bubble, streamed);
			streamed = "";
			bubble = this.messagesEl.createDiv({ cls: "vault-scout-message is-assistant is-streaming" });
		};

		try {
			const incomplete = await this.agent.send(text, this.plugin.settings.model, this.plugin.settings.extraInstructions, {
				onText: (delta) => {
					streamed += delta;
					bubble.setText(streamed);
					scroll();
				},
				onTool: (call) => {
					const label = toolLabel(call);
					turn.steps.push(label);
					steps.add(label);
					scroll();
				},
				onRoundEnd: keepRound,
			}, abort.signal);
			this.noteStreaming();
			if (incomplete) this.messagesEl.createDiv({ cls: "vault-scout-error", text: `The answer is incomplete (${incomplete}).` });
		} catch (error) {
			this.noteStreaming();
			keepRound();
			this.messagesEl.createDiv({ cls: "vault-scout-error", text: describe(error) });
		} finally {
			steps.finish();
			if (!bubble.hasChildNodes()) bubble.remove();
			if (this.abort === abort) {
				this.abort = undefined;
				this.sendButton.setIcon("send").setTooltip("Send");
			}
			scroll();
		}
		try {
			chat.skills = this.agent.loadedSkills();
			await this.plugin.chats.save(chat);
			if (chat === this.chat) this.updateHeader();
		} catch (error) {
			new Notice(`The chat could not be saved: ${describe(error)}`);
		}
	}

	private noteStreaming() {
		const reason = streamingUnavailableReason();
		if (!reason || this.streamingNoteShown) return;
		this.streamingNoteShown = true;
		this.messagesEl.createDiv({ cls: "vault-scout-tool", text: `Answers arrive at once here, because ${reason}.` });
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

/** A turn's research steps as one collapsible line: the latest step while working, the count when done. */
class StepList {
	private details: HTMLDetailsElement | undefined;
	private summary!: HTMLElement;
	private list!: HTMLElement;
	private count = 0;

	constructor(private parent: HTMLElement, private before?: HTMLElement) {}

	add(label: string) {
		if (!this.details) {
			this.details = this.parent.createEl("details", { cls: "vault-scout-steps" });
			if (this.before) this.parent.insertBefore(this.details, this.before);
			this.summary = this.details.createEl("summary");
			this.list = this.details.createDiv();
		}
		this.count++;
		this.list.createDiv({ cls: "vault-scout-tool", text: label });
		this.summary.setText(`${label} (${this.count})`);
	}

	finish() {
		if (this.details) this.summary.setText(`${this.count} research step${this.count === 1 ? "" : "s"}`);
	}
}
