export const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
export const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;
export const ACCOUNTS_FILE = "codex-accounts.json";
export const PROVIDER_NAME = "openai-codex";
export const QUOTA_ERROR_PATTERNS = [
	"quota",
	"limit",
	"rate limit",
	"429",
	"insufficient_quota",
];
export const AUTH_ERROR_PATTERNS = [
	"401",
	"unauthorized",
	"invalid_token",
	"expired_token",
];
