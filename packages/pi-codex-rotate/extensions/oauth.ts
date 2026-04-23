import { homedir } from "node:os";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CodexAccount } from "./types.js";
import { logCodexRotateError } from "./logger.js";

const loadModule = async <T = any>(specifier: string): Promise<T> => import(specifier) as Promise<T>;

function asObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function getOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getRequiredRefreshToken(data: Record<string, unknown>): string | null {
	const refreshToken = data.refreshToken ?? data.refresh_token;
	return typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null;
}

function getAccountId(credentials: Record<string, unknown>): string {
	const accountId = credentials.accountId;
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error("Missing Codex accountId in OAuth credentials");
	}
	return accountId;
}

async function getAuthStorage(): Promise<any> {
	const mod = await loadModule<any>("@mariozechner/pi-coding-agent");
	return new mod.AuthStorage();
}

async function getRefreshOpenAICodexToken(): Promise<(refreshToken: string) => Promise<any>> {
	const mod = await loadModule<any>("@mariozechner/pi-ai/oauth");
	return mod.refreshOpenAICodexToken as (refreshToken: string) => Promise<any>;
}

async function openBrowser(url: string): Promise<void> {
	try {
		const { execFile } = await import("node:child_process");
		if (process.platform === "win32") {
			execFile("powershell", ["-c", `Start-Process '${url.replace(/'/g, "''")}'`], () => {});
		} else {
			const cmd = process.platform === "darwin" ? "open" : "xdg-open";
			execFile(cmd, [url], () => {});
		}
	} catch {
		// ignore
	}
}

export async function performOAuthLogin(
	email?: string,
	callbacks?: {
		onStatus?: (message: string) => void;
		onManualCodeInput?: () => Promise<string>;
	},
): Promise<Omit<CodexAccount, "id" | "addedAt" | "lastUsed" | "disabled">> {
	const { onStatus, onManualCodeInput } = callbacks ?? {};
	const authStorage = await getAuthStorage();

	await authStorage.login("openai-codex", {
		onAuth: (info: { url: string; instructions?: string }) => {
			onStatus?.(`Opening browser for Codex OAuth...\nURL: ${info.url}`);
			void openBrowser(info.url);
			if (info.instructions) onStatus?.(info.instructions);
		},
		onPrompt: async (prompt: { message: string }) => {
			if (onManualCodeInput) return onManualCodeInput();
			throw new Error(`OAuth browser flow failed: ${prompt.message}`);
		},
		onProgress: (message: string) => onStatus?.(message),
		onManualCodeInput,
	});

	const credential = authStorage.get("openai-codex");
	if (!credential || credential.type !== "oauth") {
		throw new Error("OAuth login succeeded but no credential was stored");
	}

	const access = credential.access;
	const refresh = credential.refresh;
	const accountId = credential.accountId;
	if (!access || !refresh || !accountId) {
		throw new Error("Stored OAuth credential is missing required fields");
	}

	return {
		email,
		accountId,
		refreshToken: refresh,
		accessToken: access,
		expiresAt: credential.expires,
	};
}

export async function refreshAccountToken(
	account: CodexAccount,
): Promise<Omit<CodexAccount, "id" | "addedAt" | "lastUsed" | "disabled">> {
	try {
		const refreshOpenAICodexToken = await getRefreshOpenAICodexToken();
		const credentials = await refreshOpenAICodexToken(account.refreshToken);
		return {
			email: account.email,
			accountId: getAccountId(credentials),
			refreshToken: credentials.refresh,
			accessToken: credentials.access,
			expiresAt: credentials.expires,
		};
	} catch (error) {
		logCodexRotateError(`Failed to refresh token for account ${account.id}:`, error);
		throw error;
	}
}

export async function importFromExistingCodexAuth(): Promise<CodexAccount | null> {
	try {
		const codexAuthPath = join(homedir(), ".codex", "auth.json");
		if (!existsSync(codexAuthPath)) return null;
		const content = readFileSync(codexAuthPath, "utf-8");
		const data = asObject(JSON.parse(content));
		if (!data) return null;
		const refreshToken = getRequiredRefreshToken(data);
		if (!refreshToken) return null;
		const refreshOpenAICodexToken = await getRefreshOpenAICodexToken();
		const credentials = await refreshOpenAICodexToken(refreshToken);
		return {
			email: getOptionalString(data.email),
			accountId: getAccountId(credentials),
			refreshToken: credentials.refresh,
			accessToken: credentials.access,
			expiresAt: credentials.expires,
			addedAt: Date.now(),
			id: `imported_${Date.now()}`,
			lastUsed: undefined,
			disabled: false,
		};
	} catch (error) {
		logCodexRotateError("Failed to import from ~/.codex/auth.json:", error);
		return null;
	}
}

export async function importFromCockpit(): Promise<CodexAccount[]> {
	try {
		const cockpitDir = join(homedir(), ".antigravity_cockpit", "codex_accounts");
		if (!existsSync(cockpitDir)) return [];
		const refreshOpenAICodexToken = await getRefreshOpenAICodexToken();
		const files = readdirSync(cockpitDir).filter((f) => f.endsWith(".json"));
		const accounts: CodexAccount[] = [];
		for (const file of files) {
			try {
				const content = readFileSync(join(cockpitDir, file), "utf-8");
				const data = asObject(JSON.parse(content));
				if (!data) continue;
				const refreshToken = getRequiredRefreshToken(data);
				if (!refreshToken) continue;
				const credentials = await refreshOpenAICodexToken(refreshToken);
				accounts.push({
					email: getOptionalString(data.email),
					accountId: getAccountId(credentials),
					refreshToken: credentials.refresh,
					accessToken: credentials.access,
					expiresAt: credentials.expires,
					addedAt: Date.now(),
					id: `cockpit_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
					lastUsed: undefined,
					disabled: false,
				});
			} catch (error) {
				logCodexRotateError(`Failed to import ${file}:`, error);
			}
		}
		return accounts;
	} catch (error) {
		logCodexRotateError("Failed to import from Cockpit Tools:", error);
		return [];
	}
}
