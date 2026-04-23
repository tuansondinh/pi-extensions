import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexAccount } from "./types.js";
import { PROVIDER_NAME } from "./config.js";
import { logCodexRotateError } from "./logger.js";

const loadModule = async <T = any>(specifier: string): Promise<T> => import(specifier) as Promise<T>;

type LockResult<T> = { result: T; next?: string };
type FileAuthStorageBackendLike = {
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
};

type ApiKeyCredential = { type: "api_key"; key: string };
type AuthCredential = ApiKeyCredential;
type AuthStorageData = Record<string, AuthCredential | AuthCredential[]>;

function getAgentDirImpl(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), ".pi", "agent");
}

async function getFileAuthStorageBackend(): Promise<FileAuthStorageBackendLike> {
	const mod = await loadModule<any>("@mariozechner/pi-coding-agent");
	return new mod.FileAuthStorageBackend();
}

export async function syncAccountsToAuth(accounts: CodexAccount[]): Promise<boolean> {
	try {
		const storage = await getFileAuthStorageBackend();
		await storage.withLockAsync(async (current) => {
			let authData: AuthStorageData = {};
			if (current) {
				try {
					authData = JSON.parse(current) as AuthStorageData;
				} catch {
					// ignore malformed auth
				}
			}

			const credentials: ApiKeyCredential[] = accounts
				.filter((acc) => !acc.disabled)
				.sort((a, b) => {
					const lastUsedDiff = (b.lastUsed ?? 0) - (a.lastUsed ?? 0);
					if (lastUsedDiff !== 0) return lastUsedDiff;
					return b.addedAt - a.addedAt;
				})
				.map((acc) => ({ type: "api_key", key: acc.accessToken }));

			if (credentials.length > 0) {
				authData[PROVIDER_NAME] = credentials;
			} else {
				delete authData[PROVIDER_NAME];
			}

			return { result: true, next: JSON.stringify(authData, null, 2) };
		});
		return true;
	} catch (error) {
		logCodexRotateError("Failed to sync accounts to auth.json:", error);
		return false;
	}
}

export async function removeCodexFromAuth(): Promise<boolean> {
	try {
		const storage = await getFileAuthStorageBackend();
		await storage.withLockAsync(async (current) => {
			let authData: AuthStorageData = {};
			if (current) {
				try {
					authData = JSON.parse(current) as AuthStorageData;
				} catch {
					// ignore malformed auth
				}
			}
			delete authData[PROVIDER_NAME];
			return { result: true, next: JSON.stringify(authData, null, 2) };
		});
		return true;
	} catch (error) {
		logCodexRotateError("Failed to remove codex from auth.json:", error);
		return false;
	}
}

export function hasCodexInAuth(): boolean {
	try {
		const authPath = join(getAgentDirImpl(), "auth.json");
		if (!existsSync(authPath)) return false;
		const content = readFileSync(authPath, "utf-8");
		const authData = JSON.parse(content) as AuthStorageData;
		return PROVIDER_NAME in authData;
	} catch (error) {
		logCodexRotateError("Failed to check auth.json:", error);
		return false;
	}
}
