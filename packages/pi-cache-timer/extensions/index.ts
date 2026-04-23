import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ExtensionUIContext {
	setStatus(key: string, text: string | undefined): void;
	notify(message: string, type?: "info" | "warning" | "error" | "success"): void;
}

interface ExtensionAPI {
	on(event: string, handler: (...args: any[]) => unknown): void;
	registerCommand(
		name: string,
		command: {
			description: string;
			handler: (...args: any[]) => Promise<void> | void;
		},
	): void;
}

function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return envDir;
	}
	return join(homedir(), ".pi", "agent");
}

const STATUS_KEY = "cache-timer";
const IS_CACHE_TIMER_FORCED_OFF =
	process.env.PI_DISABLE_CACHE_TIMER === "1" ||
	process.env.PI_DISABLE_CACHE_TIMER === "true" ||
	process.env.LSD_DISABLE_CACHE_TIMER === "1" ||
	process.env.GSD_DISABLE_CACHE_TIMER === "1";

const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const ANSI_RED = "\x1b[31m";

function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function readEnabled(): boolean {
	try {
		const path = getSettingsPath();
		if (!existsSync(path)) return true;
		const settings = JSON.parse(readFileSync(path, "utf-8")) as { cacheTimer?: boolean };
		return settings.cacheTimer !== false;
	} catch {
		return true;
	}
}

function writeEnabled(enabled: boolean): void {
	const path = getSettingsPath();
	let settings: Record<string, unknown> = {};
	try {
		if (existsSync(path)) {
			settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		}
	} catch {
		// ignore parse errors, start fresh
	}
	settings.cacheTimer = enabled;
	writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const time = `${minutes}:${seconds.toString().padStart(2, "0")}`;

	if (ms >= 10 * 60 * 1000) {
		return `${ANSI_RED}⏱ ${time}${ANSI_RESET}`;
	}
	if (ms >= 5 * 60 * 1000) {
		return `${ANSI_YELLOW}⏱ ${time}${ANSI_RESET}`;
	}
	return `${ANSI_GREEN}⏱ ${time}${ANSI_RESET}`;
}

export default function cacheTimerExtension(pi: ExtensionAPI) {
	if (IS_CACHE_TIMER_FORCED_OFF) {
		return;
	}

	let timer: ReturnType<typeof setInterval> | null = null;
	let startTime: number | null = null;
	let enabled = readEnabled();
	let ui: ExtensionUIContext | null = null;

	function stopTimer(): void {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		startTime = null;
		if (ui !== null) {
			ui.setStatus(STATUS_KEY, undefined);
		}
	}

	function startTimer(uiCtx: ExtensionUIContext): void {
		stopTimer();
		if (!enabled) return;
		ui = uiCtx;
		startTime = Date.now();
		uiCtx.setStatus(STATUS_KEY, formatElapsed(0));
		timer = setInterval(() => {
			if (startTime !== null && ui !== null) {
				ui.setStatus(STATUS_KEY, formatElapsed(Date.now() - startTime));
			}
		}, 1000);
	}

	pi.on("agent_end", async (_event, ctx) => {
		startTimer(ctx.ui);
	});

	pi.on("agent_start", async (_event, ctx) => {
		ui = ctx.ui;
		stopTimer();
	});

	pi.on("session_shutdown", () => {
		stopTimer();
	});

	pi.registerCommand("cache-timer", {
		description: "Toggle cache elapsed-time timer in footer",
		async handler(_args, ctx) {
			enabled = !enabled;
			writeEnabled(enabled);
			if (enabled) {
				ctx.ui.notify("Cache timer enabled", "info");
				return;
			}
			stopTimer();
			ctx.ui.notify("Cache timer disabled", "info");
		},
	});
}
