import type { ExtensionAPI, ExtensionCommandContext } from "./extension-api.js";
import type { CodexAccount } from "./types.js";
import {
	addAccount,
	getAccountByEmail,
	getAccountById,
	getAllAccounts,
	removeAccount,
	updateAccount,
} from "./accounts.js";
import {
	performOAuthLogin,
	refreshAccountToken,
	importFromExistingCodexAuth,
	importFromCockpit,
} from "./oauth.js";
import { syncAccountsToAuth } from "./sync.js";
import { logCodexRotateError } from "./logger.js";

function formatTimestamp(timestamp?: number): string {
	if (!timestamp) return "never";
	const date = new Date(timestamp);
	const diffMins = Math.floor((Date.now() - date.getTime()) / 60000);
	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	const diffHours = Math.floor(diffMins / 60);
	if (diffHours < 24) return `${diffHours}h ago`;
	return date.toLocaleDateString();
}

function formatExpiry(expiresAt: number): string {
	const diffMins = Math.floor((expiresAt - Date.now()) / 60000);
	if (diffMins < 0) return "expired";
	if (diffMins < 5) return "expires soon";
	if (diffMins < 60) return `${diffMins}m`;
	return `${Math.floor(diffMins / 60)}h`;
}

function displayAccounts(ctx: ExtensionCommandContext, accounts: CodexAccount[]): void {
	if (accounts.length === 0) {
		ctx.ui.notify("No Codex accounts configured.", "info");
		return;
	}

	const lines: string[] = [];
	for (const [index, acc] of accounts.entries()) {
		const status = acc.disabled ? "✗" : "✓";
		const email = acc.email || acc.accountId;
		const lastUsed = acc.lastUsed ? formatTimestamp(acc.lastUsed) : "never";
		const expiry = formatExpiry(acc.expiresAt);
		lines.push(`${index + 1}. ${status} ${email}`);
		lines.push(`   Last used: ${lastUsed}, Token: ${expiry}`);
		if (acc.disabled && acc.disabledReason) {
			lines.push(`   Reason: ${acc.disabledReason}`);
		}
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

async function syncAccountsToAuthAndReload(ctx: ExtensionCommandContext): Promise<boolean> {
	const synced = await syncAccountsToAuth(getAllAccounts());
	if (synced) {
		ctx.modelRegistry.authStorage.reload();
	}
	return synced;
}

function resolveAccount(selector: string): CodexAccount | undefined {
	const index = parseInt(selector, 10);
	const accounts = getAllAccounts();
	if (!Number.isNaN(index) && index > 0 && index <= accounts.length) {
		return accounts[index - 1];
	}
	return getAccountByEmail(selector) || getAccountById(selector);
}

export function registerCodexCommand(pi: ExtensionAPI): void {
	pi.registerCommand("codex", {
		description: "Manage Codex OAuth accounts: /codex [add|list|status|remove|enable|disable|import|import-cockpit|sync]",
		getArgumentCompletions(prefix: string) {
			const subcommands = [
				"add",
				"list",
				"status",
				"remove",
				"enable",
				"disable",
				"import",
				"import-cockpit",
				"sync",
			];
			const parts = prefix.trim().split(/\s+/);
			if (parts.length <= 1) {
				return subcommands
					.filter((cmd) => cmd.startsWith(parts[0] ?? ""))
					.map((cmd) => ({ value: cmd, label: cmd }));
			}
			if (["remove", "enable", "disable"].includes(parts[0] ?? "")) {
				return getAllAccounts().map((acc, idx) => ({
					value: `${parts[0]} ${idx + 1}`,
					label: `${idx + 1} — ${acc.email || acc.accountId}`,
				}));
			}
			return [];
		},
		async handler(args, ctx) {
			const parts = args.trim().split(/\s+/);
			const sub = parts[0] || "list";
			try {
				switch (sub) {
					case "add": {
						ctx.ui.notify("Starting OAuth login flow...", "info");
						const accountData = await performOAuthLogin(undefined, {
							onStatus: (msg) => ctx.ui.notify(msg, "info"),
							onManualCodeInput: async () =>
								(await ctx.ui.input("Paste redirect URL from browser:", "http://localhost:...")) ?? "",
						});
						const emailInput = await ctx.ui.input(
							"Email for this account (optional, press Enter to skip)",
							"",
						);
						const account = addAccount({
							...accountData,
							email: emailInput || undefined,
							lastUsed: undefined,
							disabled: false,
						});
						const success = await syncAccountsToAuthAndReload(ctx);
						ctx.ui.notify(
							success
								? `Added account: ${account.email || account.accountId}. Synced to auth.json.`
								: `Added account: ${account.email || account.accountId}. Failed to sync to auth.json.`,
							success ? "success" : "warning",
						);
						return;
					}
					case "list": {
						displayAccounts(ctx, getAllAccounts());
						return;
					}
					case "status": {
						const accounts = getAllAccounts();
						const activeCount = accounts.filter((a) => !a.disabled).length;
						const disabledCount = accounts.length - activeCount;
						const expiringSoon = accounts.filter((a) => !a.disabled && a.expiresAt - Date.now() < 5 * 60 * 1000).length;
						const lines = [
							"Codex OAuth Rotation Status",
							"===========================",
							`Total accounts: ${accounts.length}`,
							`Active: ${activeCount}, Disabled: ${disabledCount}`,
							`Expiring soon: ${expiringSoon}`,
						];
						if (accounts.length > 0) {
							lines.push("", "Accounts:");
							for (const [index, acc] of accounts.entries()) {
								lines.push(`  ${index + 1}. ${acc.disabled ? "✗" : "✓"} ${acc.email || acc.accountId} (${formatExpiry(acc.expiresAt)})`);
							}
						}
						ctx.ui.notify(lines.join("\n"), "info");
						return;
					}
					case "remove":
					case "enable":
					case "disable": {
						const selector = parts[1];
						if (!selector) {
							ctx.ui.notify(`Usage: /codex ${sub} <index|email>`, "error");
							return;
						}
						const account = resolveAccount(selector);
						if (!account) {
							ctx.ui.notify(`Account not found: ${selector}`, "error");
							return;
						}
						if (sub === "remove") {
							const confirmed = await ctx.ui.select(
								`Remove account: ${account.email || account.accountId}?`,
								["Yes, remove", "Cancel"],
								{ signal: AbortSignal.timeout(30000) },
							);
							if (confirmed === "Yes, remove") {
								removeAccount(account.id);
								await syncAccountsToAuthAndReload(ctx);
								ctx.ui.notify(`Removed account: ${account.email || account.accountId}`, "success");
							}
							return;
						}
						if (sub === "enable") {
							updateAccount(account.id, { disabled: false, disabledReason: undefined });
							await syncAccountsToAuthAndReload(ctx);
							ctx.ui.notify(`Enabled account: ${account.email || account.accountId}`, "success");
							return;
						}
						updateAccount(account.id, { disabled: true, disabledReason: "manually disabled" });
						await syncAccountsToAuthAndReload(ctx);
						ctx.ui.notify(`Disabled account: ${account.email || account.accountId}`, "success");
						return;
					}
					case "import": {
						ctx.ui.notify("Importing from ~/.codex/auth.json...", "info");
						const imported = await importFromExistingCodexAuth();
						if (!imported) {
							ctx.ui.notify("No account found to import.", "warning");
							return;
						}
						addAccount({
							email: imported.email,
							accountId: imported.accountId,
							refreshToken: imported.refreshToken,
							accessToken: imported.accessToken,
							expiresAt: imported.expiresAt,
							lastUsed: undefined,
							disabled: false,
						});
						await syncAccountsToAuthAndReload(ctx);
						ctx.ui.notify(`Imported account: ${imported.email || imported.accountId}`, "success");
						return;
					}
					case "import-cockpit": {
						ctx.ui.notify("Importing from Cockpit Tools...", "info");
						const imported = await importFromCockpit();
						if (imported.length === 0) {
							ctx.ui.notify("No accounts found to import.", "warning");
							return;
						}
						for (const acc of imported) addAccount(acc);
						await syncAccountsToAuthAndReload(ctx);
						ctx.ui.notify(`Imported ${imported.length} account(s) from Cockpit Tools`, "success");
						return;
					}
					case "sync": {
						ctx.ui.notify("Refreshing all tokens and syncing to auth.json...", "info");
						const accounts = getAllAccounts();
						const results = { success: 0, failed: 0 };
						for (const acc of accounts) {
							if (acc.disabled) continue;
							try {
								const refreshed = await refreshAccountToken(acc);
								updateAccount(acc.id, refreshed);
								results.success++;
							} catch (error) {
								logCodexRotateError(`Failed to refresh ${acc.id}:`, error);
								results.failed++;
							}
						}
						await syncAccountsToAuthAndReload(ctx);
						ctx.ui.notify(
							results.failed === 0
								? `Synced ${results.success} account(s) to auth.json`
								: `Synced ${results.success} account(s), ${results.failed} failed`,
							results.failed === 0 ? "success" : "warning",
						);
						return;
					}
					default:
						ctx.ui.notify(
							"Usage: /codex [add|list|status|remove|enable|disable|import|import-cockpit|sync]",
							"info",
						);
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Error: ${message}`, "error");
			}
		},
	});
}
