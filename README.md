# Vault Scout

Prototype: research your Obsidian vault with ChatGPT, on desktop **and iOS**, billed to your own ChatGPT Plus or Pro plan through [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) (open-source plan usage, announced at OpenAI DevDay 2026).

## What it does

- **Sign in with ChatGPT** (OAuth with PKCE, dynamic client registration). The flow only allows a `127.0.0.1` callback, which a plugin cannot serve on mobile. So the browser lands on an unreachable page, and you paste that page's address back into Obsidian. The same works on desktop.
- **Chat view** with streamed answers from the Responses API (`stream: true`, `store: false`, as plan usage requires).
- **Vault tools** the model calls itself: `search_notes` (full text, folder and tag filters, frontmatter summary, snippets), `read_note` (chunked), `list_folder`, `get_links` (links and backlinks).
- **Writing with approval:** `create_note`, `edit_note` (one exact passage) and `append_to_note`. Every change is shown as a diff and only written after you approve it (setting *Confirm changes*).
- **Chats as notes** in `Vault Scout/Chats/` (`type: Agent Chat`): they sync, can be linked, and can be continued from the chat list. Questions, research steps and answers are saved; tool output is not.
- **Skills** in `Vault Scout/Skills/<name>/SKILL.md`, in the same format as skills for Claude Code and Codex. Only names and descriptions of enabled skills go into the instructions. A loaded skill stays in the instructions for the rest of the chat; files listed under `vault-scout-context` in its frontmatter load with it. *Install skills* works on mobile too: the Prism skill with one tap, or any GitHub folder with a `SKILL.md` (text files only, `{{VAULT}}` becomes the vault root). On desktop, skills installed for Claude Code and Codex can be imported as well. Each skill can be turned on and off, updated from its source, or moved to the trash. A note added to every loaded skill maps script steps to the plugin's tools.
- **`check_prism`** opens a note so Prism renders it, then reports block statuses and errors from `.prism/errors.json`. It replaces the command-line render loop of the Prism skill.
- Answers cite notes as links that open in Obsidian.

## Design notes

- **Tokens are stored per device** in the vault's `localStorage` (`App.saveLocalStorage`), never in `data.json`. Refresh tokens rotate on every refresh, so a session synced between devices would log the devices out of each other. Each device signs in once with its own `ext_agent_host_id`.
- **Streaming works on desktop only.** Successful plan-usage responses carry no CORS header (error responses do), so `fetch` is blocked in the WebView. The desktop app streams through Node's `https` module instead, imported behind `Platform.isDesktop`. The mobile app has no Node, `requestUrl` cannot stream, and the Responses WebSocket endpoint sends no `WWW-Authenticate` challenge, so browsers never send credentials to it. On mobile each tool round therefore arrives at once.
- **History stays client-side.** With `store: false` each request resends the conversation. Reasoning is carried over as `encrypted_content`. If plan usage rejects that parameter, the plugin falls back to plain turns.
- **ID token:** its claims (`iss`, `aud`, `nonce`, `sub`) are checked, but its signature is not. The token comes straight from the token endpoint over TLS (OIDC Core 3.1.3.7), and the JWKS endpoint does not allow cross-origin requests.

## Development

```sh
npm install
npm run build             # type check + bundle main.js
npm run lint              # official eslint-plugin-obsidianmd recommended config
npm run deploy -- <vault>  # copy main.js, manifest.json, styles.css into <vault>/.obsidian/plugins/vault-scout
```

## Open questions to verify on a device

1. Does the sign-in flow accept the pasted callback on iOS (Safari or the in-app browser)?
2. Will OpenAI add the missing CORS header to successful plan-usage responses? That would enable streaming on mobile.
3. Does plan usage accept `include: ["reasoning.encrypted_content"]` and function tools?
4. Is OpenAI's hosted `web_search` tool available with plan usage? It is not used yet.
