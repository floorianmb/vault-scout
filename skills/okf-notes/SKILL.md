---
name: okf-notes
description: Create or edit notes in a vault that follows the Open Knowledge Format (OKF 0.2) - frontmatter (type, title, description, tags, status, generated), sources and footnotes, links, and folder index entries. Use whenever a note is created, extended or restructured in such a vault. Not for full maintenance runs across the vault.
vault-scout-context:
  - AGENTS.md
  - CLAUDE.md
---

# OKF-conformant notes

This skill covers single notes you create or change during a conversation. It does not cover vault-wide maintenance runs (audits, bulk frontmatter, logs); point the user to their maintenance tooling for those.

Reference: [OKF specification](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md). Section numbers below refer to it.

## 1. The vault's own rules come first

1. Read the vault's agent instructions, loaded below if the vault has an `AGENTS.md` or `CLAUDE.md` at its root. Follow every convention note, metadata profile or template they point to (read those files once per chat). Local rules override the baseline in section 3.
2. Check that the vault uses OKF: a root `index.md` with `okf_version`, or notes with a `type` in their frontmatter. If it does not, ask the user before adding OKF frontmatter.
3. Look at one or two existing notes of the same kind in the target folder and match their fields, field order and style.

## 2. Before writing

- Read the target folder's `index.md` if it exists.
- For a summary of other notes, read those notes first; you will cite them.

## 3. Baseline for a new note (when the vault defines nothing else)

Frontmatter (§4.1, §5):

- `type` (required): a short, descriptive kind, for example `Note`, `Learning Note`, `Meeting Note`, `Playbook`, `Reference`. Prefer a type the vault already uses; use `Note` when none fits.
- `title`, `description` (one sentence that summarizes the note without adding claims) and `tags` (a YAML list).
- `status: draft`. The note has not been reviewed yet (§5.4).
- `generated` (§5.2, §7): `by` is your actor, `vault-scout/<model slug>` with the model you are running as; `at` is the current time in UTC, for example `"2026-10-10T20:15:00Z"`. All timestamps are ISO 8601 with an explicit offset.
- `sources` (§5.1): only materials you actually read and used. Each entry needs `resource` (a URL or a vault path) and should have an `id` when the text cites it. Attribute individual claims with footnotes keyed by that id: `…sharded daily.[^ga4-schema]`. When you summarize another note, list it in `sources` and link it in the text.
- Never add `verified` yourself, and never a `human:` actor (§5.3). Add `stale_after` only if the vault asks for it.

Body (§4.2): structural Markdown (headings, lists, tables, fenced code). Keep the user's language.

Reserved names (§3.1): never create a note named `index.md` or `log.md`.

## 4. Index entries (§8)

If the folder has an `index.md`, add the new note there:

```markdown
* [Title](Relative%20link.md) - description from the note's frontmatter
```

Keep existing sections, manual groupings and comments; no duplicates. Index files carry no frontmatter, except `okf_version` in the root index. For a new folder, create its `index.md` and link it from the parent index, if the vault keeps indexes. Write to `log.md` only if the vault's rules ask for it (§9).

## 5. Links (§6)

- Use the link style the vault already uses. Without a convention, use standard Markdown links with paths relative to the current note, URL-encoding spaces and `%`, for example `[Title](../Folder/My%20Note.md)`.
- Claim a relationship only after reading both notes; a similar topic is not a source. The surrounding sentence says what the relationship is.
- If the vault defines a block for automatically added links, put new links only there.

## 6. Changing existing notes

- Keep the user's text, checkboxes, dates, sources and unknown frontmatter keys (§4.1 Extensions). Make small, targeted edits.
- Formatting or adding metadata is not verification. Do not mark human-written text as AI-generated.
- Update `generated.at` only for a meaningful content change, if the note already records `generated`.
- Do not rename, move or delete notes, and do not edit control files (`AGENTS.md`, `CLAUDE.md`, `SKILL.md`), hidden folders or the Obsidian configuration.
