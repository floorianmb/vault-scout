import { App, requestUrl } from "obsidian";
import { asRecord, asString, JsonRecord, parseJson } from "./json";

// Sign in with ChatGPT, plan usage for open-source apps:
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const APP_NAME = "Vault Scout";
// The flow only accepts a 127.0.0.1 callback. Nothing listens there on mobile:
// the browser shows a connection error and the user pastes that address back.
const REDIRECT_URI = "http://127.0.0.1:1455/auth/callback";
const PENDING_TTL = 30 * 60 * 1000;
const REFRESH_MARGIN = 2 * 60 * 1000;

// Never synced: refresh tokens rotate on every refresh, so two devices sharing
// one session would log each other out. Tokens and the PKCE verifier live in
// Obsidian's SecretStorage (the device keychain); the host and client IDs are
// not secret and stay in the vault's localStorage. Idea from Chatting with AI
// (github.com/o1xhack/obsidian-chatting).
const KEY_HOST = "vault-scout-host-id";
const KEY_CLIENT = "vault-scout-client-id";
const KEY_CONNECTION = "vault-scout-connection";
const KEY_PENDING = "vault-scout-pending-sign-in";

export interface Connection {
	clientId: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	scopes: string[];
	subject: string;
	email?: string;
	name?: string;
}

interface PendingSignIn {
	state: string;
	nonce: string;
	verifier: string;
	createdAt: number;
}

interface Discovery {
	authorization_endpoint: string;
	token_endpoint: string;
	revocation_endpoint?: string;
}

export class AuthError extends Error {
	constructor(readonly code: string, message: string, readonly status?: number) {
		super(message);
		this.name = "AuthError";
	}
}

let discoveryPromise: Promise<Discovery> | undefined;

function discovery(): Promise<Discovery> {
	discoveryPromise ??= (async () => {
		const response = await requestUrl({ url: `${ISSUER}/.well-known/openid-configuration`, throw: false });
		const data = asRecord(parseJson(response.text));
		const endpoint = (key: string) => {
			const value = asString(data?.[key]);
			return value && new URL(value).origin === ISSUER ? value : undefined;
		};
		const authorization = endpoint("authorization_endpoint");
		const token = endpoint("token_endpoint");
		if (response.status !== 200 || !authorization || !token) {
			throw new AuthError("discovery_failed", "The ChatGPT sign-in configuration could not be loaded.");
		}
		return { authorization_endpoint: authorization, token_endpoint: token, revocation_endpoint: endpoint("revocation_endpoint") };
	})().catch((error: unknown) => {
		discoveryPromise = undefined;
		throw error;
	});
	return discoveryPromise;
}

function oauthError(data: JsonRecord | undefined, status: number): AuthError {
	const nested = asRecord(data?.error);
	const code = asString(nested?.code) ?? asString(data?.error) ?? `http_${status}`;
	const message = asString(nested?.message) ?? asString(data?.error_description) ?? `ChatGPT sign-in failed (${code}).`;
	return new AuthError(code, message, status);
}

async function tokenRequest(params: Record<string, string>): Promise<JsonRecord> {
	const { token_endpoint } = await discovery();
	const response = await requestUrl({
		url: token_endpoint,
		method: "POST",
		contentType: "application/x-www-form-urlencoded",
		headers: { Accept: "application/json" },
		body: new URLSearchParams(params).toString(),
		throw: false,
	});
	const data = asRecord(parseJson(response.text));
	if (response.status >= 400 || !data) throw oauthError(data, response.status);
	return data;
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomValue(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function codeChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

/**
 * Reads the ID token claims without checking the signature. The token comes
 * straight from the token endpoint over TLS in exchange for our own code, which
 * OpenID Connect Core 3.1.3.7 accepts in place of signature validation.
 */
function idTokenClaims(idToken: string, clientId: string, nonce?: string): JsonRecord {
	const payload = idToken.split(".")[1];
	const json = payload
		? new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))
		: "";
	const claims = asRecord(parseJson(json));
	const audience = claims?.aud;
	const audiences = Array.isArray(audience) ? audience : [audience];
	if (!claims || claims.iss !== ISSUER || !asString(claims.sub) || !audiences.includes(clientId) ||
		(nonce !== undefined && claims.nonce !== nonce)) {
		throw new AuthError("invalid_id_token", "The ChatGPT identity could not be verified. Please sign in again.");
	}
	return claims;
}

/** Accepts the full callback address, or just its query string. */
function callbackParams(pasted: string): URLSearchParams {
	const text = pasted.trim();
	try {
		return new URL(text).searchParams;
	} catch {
		return new URLSearchParams(text.slice(text.indexOf("?") + 1));
	}
}

export class ChatGPTAuth {
	private refreshing: Promise<Connection> | undefined;
	private listeners = new Set<() => void>();

	constructor(private app: App) {
		// Move sign-ins saved by earlier versions from localStorage into SecretStorage.
		for (const key of [KEY_CONNECTION, KEY_PENDING]) {
			const legacy: unknown = this.app.loadLocalStorage(key);
			if (legacy === null || legacy === undefined) continue;
			if (!this.readSecret(key)) this.writeSecret(key, legacy);
			this.app.saveLocalStorage(key, null);
		}
	}

	get connection(): Connection | undefined {
		const stored = asRecord(this.readSecret(KEY_CONNECTION));
		return stored && asString(stored.accessToken) ? (stored as unknown as Connection) : undefined;
	}

	private readSecret(key: string): unknown {
		const raw = this.app.secretStorage.getSecret(key);
		return raw ? parseJson(raw) : undefined;
	}

	/** SecretStorage has no delete; an empty string clears the entry. */
	private writeSecret(key: string, value: unknown) {
		this.app.secretStorage.setSecret(key, value === null || value === undefined ? "" : JSON.stringify(value));
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Returns the authorization URL to open in the browser. */
	async startSignIn(): Promise<string> {
		const { authorization_endpoint } = await discovery();
		const pending: PendingSignIn = { state: randomValue(), nonce: randomValue(), verifier: randomValue(), createdAt: Date.now() };
		// Persisted, because iOS may reload Obsidian while the user is in Safari.
		this.writeSecret(KEY_PENDING, pending);
		const clientId = this.savedClientId();
		const url = new URL(authorization_endpoint);
		url.search = new URLSearchParams({
			client_id: clientId ?? "dynamic_agent_client",
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES,
			resource: RESOURCE,
			state: pending.state,
			nonce: pending.nonce,
			code_challenge_method: "S256",
			code_challenge: await codeChallenge(pending.verifier),
			ext_agent_host_id: this.hostId(),
		}).toString();
		if (!clientId) url.searchParams.set("agent_name_hint", APP_NAME);
		const email = this.connection?.email;
		if (email) url.searchParams.set("login_hint", email);
		return url.toString();
	}

	/** Finishes sign-in with the callback address the user copied from the browser. */
	async completeSignIn(pasted: string): Promise<Connection> {
		const pending = asRecord(this.readSecret(KEY_PENDING)) as PendingSignIn | undefined;
		if (!pending || Date.now() - pending.createdAt > PENDING_TTL) {
			throw new AuthError("no_pending_sign_in", "No sign-in is in progress. Open the sign-in page again.");
		}
		const params = callbackParams(pasted);
		const error = params.get("error");
		if (error) throw new AuthError(error, params.get("error_description") ?? `ChatGPT sign-in failed (${error}).`);
		if (params.get("state") !== pending.state) {
			throw new AuthError("state_mismatch", "This address belongs to a different sign-in attempt. Open the sign-in page again.");
		}
		const code = params.get("code");
		if (!code) throw new AuthError("missing_code", "The pasted address contains no sign-in code. Copy the full address from the browser.");
		const clientId = params.get("client_id") ?? this.savedClientId();
		if (!clientId || clientId === "dynamic_agent_client" || !/^[\w-]{1,200}$/.test(clientId)) {
			throw new AuthError("registration_incomplete", "ChatGPT did not complete the app registration. Please try again.");
		}
		// Keep the issued client ID even if the code exchange fails, so a retry
		// does not register the app a second time.
		this.app.saveLocalStorage(KEY_CLIENT, clientId);

		const data = await tokenRequest({
			grant_type: "authorization_code",
			client_id: clientId,
			code,
			code_verifier: pending.verifier,
			redirect_uri: REDIRECT_URI,
			resource: RESOURCE,
		});
		this.writeSecret(KEY_PENDING, null);
		const idToken = asString(data.id_token);
		if (!idToken) throw new AuthError("invalid_id_token", "ChatGPT did not return an identity. Please sign in again.");
		const claims = idTokenClaims(idToken, clientId, pending.nonce);
		const connection = this.connectionFrom(data, clientId, claims);
		if (!connection.scopes.includes(PLAN_SCOPE)) {
			throw new AuthError("plan_usage_not_granted", "ChatGPT did not grant plan usage. Allow it when you sign in.");
		}
		this.save(connection);
		return connection;
	}

	/** A valid access token, refreshed shortly before it expires. */
	async accessToken(forceRefresh = false): Promise<string> {
		const connection = this.connection;
		if (!connection) throw new AuthError("not_connected", "Sign in with ChatGPT first.");
		if (!forceRefresh && connection.expiresAt - REFRESH_MARGIN > Date.now()) return connection.accessToken;
		this.refreshing ??= this.refresh(connection).finally(() => {
			this.refreshing = undefined;
		});
		return (await this.refreshing).accessToken;
	}

	async signOut(): Promise<void> {
		const connection = this.connection;
		this.save(undefined);
		if (!connection) return;
		const { revocation_endpoint } = await discovery();
		if (!revocation_endpoint) return;
		await requestUrl({
			url: revocation_endpoint,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: new URLSearchParams({ token: connection.refreshToken, token_type_hint: "refresh_token", client_id: connection.clientId }).toString(),
			throw: false,
		});
	}

	/** Drops the local session after the server reported it as revoked. */
	forget(): void {
		this.save(undefined);
	}

	private async refresh(connection: Connection): Promise<Connection> {
		let data: JsonRecord;
		try {
			data = await tokenRequest({
				grant_type: "refresh_token",
				client_id: connection.clientId,
				refresh_token: connection.refreshToken,
				resource: RESOURCE,
			});
		} catch (error) {
			if (error instanceof AuthError && (error.code === "invalid_grant" || error.status === 401)) this.forget();
			throw error;
		}
		const idToken = asString(data.id_token);
		const claims = idToken ? idTokenClaims(idToken, connection.clientId) : undefined;
		if (claims && claims.sub !== connection.subject) {
			this.forget();
			throw new AuthError("account_mismatch", "The refreshed ChatGPT account does not match. Please sign in again.");
		}
		const next = this.connectionFrom(data, connection.clientId, claims, connection);
		this.save(next);
		return next;
	}

	private connectionFrom(data: JsonRecord, clientId: string, claims: JsonRecord | undefined, previous?: Connection): Connection {
		const accessToken = asString(data.access_token);
		const refreshToken = asString(data.refresh_token) ?? previous?.refreshToken;
		const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 0;
		const subject = asString(claims?.sub) ?? previous?.subject;
		if (!accessToken || !refreshToken || expiresIn <= 0 || !subject) {
			throw new AuthError("invalid_token_response", "ChatGPT returned incomplete credentials. Please sign in again.");
		}
		const scope = asString(data.scope);
		return {
			clientId,
			accessToken,
			refreshToken,
			expiresAt: Date.now() + expiresIn * 1000,
			scopes: scope ? scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [],
			subject,
			email: asString(claims?.email) ?? previous?.email,
			name: asString(claims?.name) ?? previous?.name,
		};
	}

	private save(connection: Connection | undefined) {
		this.writeSecret(KEY_CONNECTION, connection ?? null);
		for (const listener of this.listeners) listener();
	}

	private savedClientId(): string | undefined {
		return asString(this.app.loadLocalStorage(KEY_CLIENT));
	}

	/**
	 * Stable per device and vault, as the flow requires one ID per host. Same
	 * `urn:uuid:` form as OpenAI's devkit; the authorize endpoint rejects others.
	 */
	private hostId(): string {
		const saved = asString(this.app.loadLocalStorage(KEY_HOST));
		if (saved?.startsWith("urn:uuid:")) return saved;
		const id = `urn:uuid:${saved && /^[0-9a-f-]{36}$/.test(saved) ? saved : crypto.randomUUID()}`;
		this.app.saveLocalStorage(KEY_HOST, id);
		return id;
	}
}
