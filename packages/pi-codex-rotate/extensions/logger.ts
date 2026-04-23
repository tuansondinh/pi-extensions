export function logCodexRotateSwitch(message: string): void {
	console.warn(`[codex-rotate] ${message}`);
}

export function logCodexRotateError(message: string, error?: unknown): void {
	if (error === undefined) {
		console.error(`[codex-rotate] ${message}`);
		return;
	}
	console.error(`[codex-rotate] ${message}`, error);
}
