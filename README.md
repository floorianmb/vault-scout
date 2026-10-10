# Vault Scout

Prototype: research your Obsidian vault with ChatGPT, on desktop **and iOS**, billed to your own ChatGPT Plus or Pro plan through [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) (open-source plan usage, announced at OpenAI DevDay 2026).

## What it does

- **Sign in with ChatGPT** (OAuth with PKCE, dynamic client registration). The flow only allows a `127.0.0.1` callback, which a plugin cannot serve on mobile. So the browser lands on an unreachable page, and you paste that page's address back into Obsidian. The same works on desktop.
- **Chat view** with streamed answers from the Responses API (`stream: true`, `store: false`, as plan usage requires).
- **Read-only vault tools** the model calls itself: `search_notes` (full text, folder and tag filters, frontmatter summary, snippets), `read_note` (chunked), `list_folder` and `get_links` (links and backlinks).
- Answers cite notes as links that open in Obsidian.

## Design notes

- **Tokens are stored per device** in the vault's `localStorage` (`App.saveLocalStorage`), never in `data.json`. Refresh tokens rotate on every refresh, so a session synced between devices would log the devices out of each other. Each device signs in once with its own `ext_agent_host_id`.
- **Streaming uses `fetch`.** `requestUrl` returns only the complete body. `api.openai.com` allows cross-origin requests (`Access-Control-Allow-Origin: *`, checked for the `capacitor://localhost` origin of the iOS app). Sign-in, token and model requests use `requestUrl`. The official lint config reports the one `fetch` as a warning and forbids disabling that rule, so the warning stays visible on purpose.
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
2. Does streaming via `fetch` work in the iOS app's WebView?
3. Does plan usage accept `include: ["reasoning.encrypted_content"]` and function tools?
4. Is OpenAI's hosted `web_search` tool available with plan usage? It is not used yet.
