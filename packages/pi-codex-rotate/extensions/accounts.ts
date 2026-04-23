import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CodexAccount, CodexAccountsStore } from "./types.js";
import { ACCOUNTS_FILE, REFRESH_BEFORE_EXPIRY_MS } from "./config.js";
import { logCodexRotateError } from "./logger.js";

let agentDir: string | null = null;

function getAgentDirImpl(): string {
	if (agentDir) return agentDir;
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		agentDir = envDir === "~" ? homedir() : envDir.startsWith("~/") ? homedir() + envDir.slice(1) : envDir;
		return agentDir;
	}
	agentDir = join(homedir(), ".pi", "agent");
	return agentDir;
}

function getAccountsPath(): string {
	return join(getAgentDirImpl(), ACCOUNTS_FILE);
}

function ensureAccountsFile(): CodexAccountsStore {
	const path = getAccountsPath();
	const dir = dirname(path);

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	if (!existsSync(path)) {
		const empty: CodexAccountsStore = { accounts: [], version: 1 };
		writeFileSync(path, JSON.stringify(empty, null, 2), "utf-8");
		chmodSync(path, 0o600);
		return empty;
	}

	try {
		const content = readFileSync(path, "utf-8");
		return JSON.parse(content) as CodexAccountsStore;
	} catch (error) {
		logCodexRotateError("Failed to read accounts file:", error);
		return { accounts: [], version: 1 };
	}
}

function writeAccountsFile(store: CodexAccountsStore): void {
	const path = getAccountsPath();
	writeFileSync(path, JSON.stringify(store, null, 2), "utf-8");
	chmodSync(path, 0o600);
}

export function getAllAccounts(): CodexAccount[] {
	return ensureAccountsFile().accounts;
}

export function getAccountById(id: string): CodexAccount | undefined {
	return getAllAccounts().find((acc) => acc.id === id);
}

export function getAccountByEmail(email: string): CodexAccount | undefined {
	return getAllAccounts().find((acc) => acc.email === email);
}

export function addAccount(account: Omit<CodexAccount, "id" | "addedAt">): CodexAccount {
	const store = ensureAccountsFile();
	const newAccount: CodexAccount = {
		...account,
		id: `acc_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
		addedAt: Date.now(),
	};
	store.accounts.push(newAccount);
	writeAccountsFile(store);
	return newAccount;
}

export function updateAccount(id: string, updates: Partial<CodexAccount>): CodexAccount | null {
	const store = ensureAccountsFile();
	const index = store.accounts.findIndex((acc) => acc.id === id);
	if (index === -1) return null;
	store.accounts[index] = { ...store.accounts[index], ...updates };
	writeAccountsFile(store);
	return store.accounts[index];
}

export function removeAccount(id: string): boolean {
	const store = ensureAccountsFile();
	const index = store.accounts.findIndex((acc) => acc.id === id);
	if (index === -1) return false;
	store.accounts.splice(index, 1);
	writeAccountsFile(store);
	return true;
}

export function getActiveAccounts(): CodexAccount[] {
	return getAllAccounts().filter((acc) => !acc.disabled);
}

export function getAccountsNeedingRefresh(): CodexAccount[] {
	const threshold = Date.now() + REFRESH_BEFORE_EXPIRY_MS;
	return getActiveAccounts().filter((acc) => acc.expiresAt < threshold);
}

export function markAccountUsed(accountId: string): void {
	updateAccount(accountId, { lastUsed: Date.now() });
}
