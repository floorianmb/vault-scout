import { App, ButtonComponent, Modal } from "obsidian";

export interface Change {
	action: "create" | "edit" | "append";
	path: string;
	/** Text that is replaced (edit only). */
	before?: string;
	/** New text: the whole note, the replacement or the appended part. */
	after: string;
	/** 1-based line where the edit starts. */
	line?: number;
}

const TITLES: Record<Change["action"], string> = {
	create: "Create note",
	edit: "Edit note",
	append: "Append to note",
};

/** Shows a proposed change and resolves with the user's decision. */
export function confirmChange(app: App, change: Change): Promise<boolean> {
	return new Promise((resolve) => new ChangeModal(app, change, resolve).open());
}

class ChangeModal extends Modal {
	private decided = false;

	constructor(app: App, private change: Change, private resolve: (approved: boolean) => void) {
		super(app);
	}

	override onOpen(): void {
		const { contentEl, change } = this;
		this.setTitle(TITLES[change.action]);
		contentEl.addClass("vault-scout-change");
		contentEl.createDiv({ cls: "vault-scout-change-path", text: change.line ? `${change.path}, line ${change.line}` : change.path });

		const diff = contentEl.createDiv({ cls: "vault-scout-diff" });
		for (const [kind, text] of diffLines(change.before ?? "", change.after)) {
			diff.createDiv({ cls: `vault-scout-diff-line is-${kind}`, text: `${kind === "add" ? "+" : kind === "del" ? "−" : " "} ${text}` });
		}

		const buttons = contentEl.createDiv({ cls: "vault-scout-modal-buttons" });
		new ButtonComponent(buttons).setButtonText("Reject").onClick(() => this.decide(false));
		new ButtonComponent(buttons).setButtonText("Apply").setCta().onClick(() => this.decide(true));
	}

	override onClose(): void {
		this.contentEl.empty();
		if (!this.decided) this.resolve(false);
	}

	private decide(approved: boolean) {
		this.decided = true;
		this.resolve(approved);
		this.close();
	}
}

type DiffLine = ["add" | "del" | "same", string];

/** Line diff via longest common subsequence; falls back to delete-all/add-all for long texts. */
function diffLines(before: string, after: string): DiffLine[] {
	const a = before ? before.split("\n") : [];
	const b = after.split("\n");
	if (a.length * b.length > 250_000) {
		return [...a.map((l): DiffLine => ["del", l]), ...b.map((l): DiffLine => ["add", l])];
	}
	const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			out.push(["same", a[i]!]);
			i++;
			j++;
		} else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
			out.push(["del", a[i++]!]);
		} else {
			out.push(["add", b[j++]!]);
		}
	}
	while (i < a.length) out.push(["del", a[i++]!]);
	while (j < b.length) out.push(["add", b[j++]!]);
	return out;
}
