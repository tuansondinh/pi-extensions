import type { ExtensionAPI, ExtensionContext } from "./extension-api.js";
import { getAllAccounts, getAccountsNeedingRefresh, updateAccount } from "./accounts.js";
import { registerCodexCommand } from "./commands.js";
import { REFRESH_INTERVAL_MS } from "./config.js";
import { logCodexRotateError } from "./logger.js";
import { refreshAccountToken } from "./oauth.js";
import { syncAccountsToAuth } from "./sync.js";

let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function reloadLiveAuthState(ctx: ExtensionContext): Promise<void> {
	ctx.modelRegistry.authStorage.reload();
}

async function refreshExpiringAccounts(ctx: ExtensionContext): Promise<void> {
	try {
		const accountsNeedingRefresh = getAccountsNeedingRefresh();
		if (accountsNeedingRefresh.length === 0) return;

		let successCount = 0;
		let failCount = 0;

		for (const account of accountsNeedingRefresh) {
			try {
				const refreshed = await refreshAccountToken(account);
				updateAccount(account.id, refreshed);
				successCount++;
			} catch (error) {
				failCount++;
				logCodexRotateError(`Failed to refresh account ${account.id}:`, error);
				updateAccount(account.id, {
					disabled: true,
					disabledReason: `Token refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}
		}

		if (successCount > 0) {
			const synced = await syncAccountsToAuth(getAllAccounts());
			if (synced) {
				await reloadLiveAuthState(ctx);
			}
		}

		if (failCount > 0 && successCount === 0) {
			logCodexRotateError(`Failed to refresh ${failCount} account(s)`);
		}
	} catch (error) {
		logCodexRotateError("Error in refresh task:", error);
	}
}

function startRefreshTimer(ctx: ExtensionContext): void {
	if (refreshTimer) clearInterval(refreshTimer);
	refreshTimer = setInterval(() => {
		void refreshExpiringAccounts(ctx);
	}, REFRESH_INTERVAL_MS);
}

function stopRefreshTimer(): void {
	if (!refreshTimer) return;
	clearInterval(refreshTimer);
	refreshTimer = null;
}

export default function codexRotateExtension(pi: ExtensionAPI) {
	registerCodexCommand(pi);

	pi.on("session_start", async (_event, ctx) => {
		const accounts = getAllAccounts();
		if (accounts.length === 0) return;
		await refreshExpiringAccounts(ctx);
		const synced = await syncAccountsToAuth(getAllAccounts());
		if (synced) {
			await reloadLiveAuthState(ctx);
		}
		startRefreshTimer(ctx);
	});

	pi.on("session_shutdown", () => {
		stopRefreshTimer();
	});
}
