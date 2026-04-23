/**
 * Based on https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/examples/extensions/sandbox/index.ts
 * by Mario Zechner, used under the MIT License.
 *
 * Sandbox Extension - OS-level sandboxing for bash commands, plus path policy
 * enforcement for pi's read/write/edit tools, with interactive permission prompts.
 *
 * Uses @carderne/sandbox-runtime to enforce filesystem and network
 * restrictions on bash commands at the OS level (sandbox-exec on macOS,
 * bubblewrap on Linux). Also intercepts the read, write, and edit tools to
 * apply the same denyRead/denyWrite/allowWrite filesystem rules, which OS-level
 * sandboxing cannot cover (those tools run directly in Node.js, not in a
 * subprocess).
 *
 * When a block is triggered, the user is prompted to:
 *   (a) Abort (keep blocked)
 *   (b) Allow for this session only  — stored in memory, agent cannot access
 *   (c) Allow for this project       — written to .pi/sandbox.json
 *   (d) Allow for all projects       — written to ~/.pi/agent/sandbox.json
 *
 * What gets prompted vs. hard-blocked:
 *   - domains: prompted if not whitelisted nor explicitly denied
 *   - write: prompted if not whitelisted nor explicitly denied
 *   - read: always prompted (because denyRead is used for broad block, may want to punch holes)
 *
 * IMPORTANT — precedence for read:
 *   Read:  allowRead OVERRIDES denyRead (prompt grant adds to allowRead)
 *   Write: denyWrite OVERRIDES allowWrite (most-specific deny wins)
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/sandbox.json (global)
 * - <cwd>/.pi/sandbox.json  (project-local)
 *
 * Example .pi/sandbox.json:
 * ```json
 * {
 *   "enabled": true,
 *   "osSandbox": false,
 *   "network": {
 *     "allowedDomains": ["github.com", "*.github.com"],
 *     "deniedDomains": []
 *   },
 *   "filesystem": {
 *     "denyRead": ["/Users", "/home"],
 *     "allowRead": [".", "~/.config", "~/.local", "Library"],
 *     "allowWrite": [".", "/tmp"],
 *     "denyWrite": [".env"]
 *   }
 * }
 * ```
 *
 * Usage:
 * - `pi -e ./sandbox` - sandbox enabled with default/config settings
 * - `pi -e ./sandbox --no-sandbox` - disable OS-level sandboxing (path policy stays active)
 * - `"osSandbox": false` in config - same as --no-sandbox but persistent
 * - `/sandbox` - show current sandbox configuration
 *
 * Setup:
 * 1. Copy sandbox/ directory to ~/.pi/agent/extensions/
 * 2. Run `npm install` in ~/.pi/agent/extensions/sandbox/
 *
 * Linux also requires: bubblewrap, socat, ripgrep
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@carderne/sandbox-runtime";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type BashOperations,
  isToolCallEventType,
} from "@mariozechner/pi-coding-agent";

interface BashPolicy {
  /** Patterns always allowed without prompt e.g. "git *", "npm *" */
  allow?: string[];
  /** Patterns that always prompt the user before running */
  ask?: string[];
  /** Patterns that are always blocked */
  deny?: string[];
}

interface SandboxConfig extends SandboxRuntimeConfig {
  enabled?: boolean;
  /** When false, disables OS-level bash sandboxing (SandboxManager) but keeps
   *  the allow/deny/ask path policy enforcement for read/write/network. */
  osSandbox?: boolean;
  /** Per-command bash allow/ask/deny patterns. Patterns are matched against
   *  the full command string. Supports glob-style wildcards (*). */
  bash?: BashPolicy;
}

const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  network: {
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["/Users", "/home"],
    allowRead: [".", "~/.config", "~/.local", "Library"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

function loadConfig(cwd: string): SandboxConfig {
  const projectConfigPath = join(cwd, ".pi", "sandbox.json");
  const globalConfigPath = join(homedir(), ".pi", "agent", "sandbox.json");

  let globalConfig: Partial<SandboxConfig> = {};
  let projectConfig: Partial<SandboxConfig> = {};

  if (existsSync(globalConfigPath)) {
    try {
      globalConfig = JSON.parse(readFileSync(globalConfigPath, "utf-8"));
    } catch (e) {
      console.error(`Warning: Could not parse ${globalConfigPath}: ${e}`);
    }
  }

  if (existsSync(projectConfigPath)) {
    try {
      projectConfig = JSON.parse(readFileSync(projectConfigPath, "utf-8"));
    } catch (e) {
      console.error(`Warning: Could not parse ${projectConfigPath}: ${e}`);
    }
  }

  return deepMerge(deepMerge(DEFAULT_CONFIG, globalConfig), projectConfig);
}

function deepMerge(base: SandboxConfig, overrides: Partial<SandboxConfig>): SandboxConfig {
  const result: SandboxConfig = { ...base };

  if (overrides.enabled !== undefined) result.enabled = overrides.enabled;
  if (overrides.osSandbox !== undefined) result.osSandbox = overrides.osSandbox;
  if (overrides.bash) {
    result.bash = {
      allow: [...(base.bash?.allow ?? []), ...(overrides.bash.allow ?? [])],
      ask:   [...(base.bash?.ask   ?? []), ...(overrides.bash.ask   ?? [])],
      deny:  [...(base.bash?.deny  ?? []), ...(overrides.bash.deny  ?? [])],
    };
  }
  if (overrides.network) {
    result.network = { ...base.network, ...overrides.network };
  }
  if (overrides.filesystem) {
    result.filesystem = { ...base.filesystem, ...overrides.filesystem };
  }

  const extOverrides = overrides as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
    allowBrowserProcess?: boolean;
  };
  const extResult = result as {
    ignoreViolations?: Record<string, string[]>;
    enableWeakerNestedSandbox?: boolean;
    allowBrowserProcess?: boolean;
  };

  if (extOverrides.ignoreViolations) {
    extResult.ignoreViolations = extOverrides.ignoreViolations;
  }
  if (extOverrides.enableWeakerNestedSandbox !== undefined) {
    extResult.enableWeakerNestedSandbox = extOverrides.enableWeakerNestedSandbox;
  }
  if (extOverrides.allowBrowserProcess !== undefined) {
    extResult.allowBrowserProcess = extOverrides.allowBrowserProcess;
  }

  return result;
}

// ── Domain helpers ────────────────────────────────────────────────────────────

function extractDomainsFromCommand(command: string): string[] {
  const urlRegex = /https?:\/\/([a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const domains = new Set<string>();
  let match;
  while ((match = urlRegex.exec(command)) !== null) {
    domains.add(match[1]);
  }
  return [...domains];
}

function domainMatchesPattern(domain: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2);
    return domain === base || domain.endsWith("." + base);
  }
  return domain === pattern;
}

function domainIsAllowed(domain: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((p) => domainMatchesPattern(domain, p));
}

// ── Bash command pattern matching ───────────────────────────────────────────

/** Match a command string against a glob pattern (only * is special). */
function commandMatchesPattern(command: string, pattern: string): boolean {
  const trimmed = command.trim();
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(trimmed);
}

/**
 * Check command against bash policy. Returns:
 *   "allow" — matched allow list or no policy defined
 *   "ask"   — matched ask list (or default when no allow list and nothing matched)
 *   "deny"  — matched deny list
 */
function checkBashPolicy(command: string, policy: BashPolicy | undefined): "allow" | "ask" | "deny" {
  if (!policy) return "allow";
  const { allow = [], ask = [], deny = [] } = policy;

  if (deny.some((p) => commandMatchesPattern(command, p))) return "deny";
  if (allow.some((p) => commandMatchesPattern(command, p))) return "allow";
  if (ask.some((p) => commandMatchesPattern(command, p))) return "ask";

  // If an allow list is defined, anything not on it defaults to ask.
  // If no allow list, anything not in ask/deny is allowed.
  return allow.length > 0 ? "ask" : "allow";
}

// ── Output analysis ─────────────────────────────────────────────────────────────

/** Extract a path from a bash "Operation not permitted" OS sandbox error. */
function extractBlockedWritePath(output: string): string | null {
  const match = output.match(/(?:\/bin\/bash|bash|sh): (\/[^\s:]+): Operation not permitted/);
  return match ? match[1] : null;
}

// ── Path pattern matching ─────────────────────────────────────────────────────

function matchesPattern(filePath: string, patterns: string[]): boolean {
  const expanded = filePath.replace(/^~/, homedir());
  const abs = resolve(expanded);
  return patterns.some((p) => {
    const expandedP = p.replace(/^~/, homedir());
    const absP = resolve(expandedP);
    if (p.includes("*")) {
      const escaped = absP.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${escaped}$`).test(abs);
    }
    return abs === absP || abs.startsWith(absP + "/");
  });
}

// ── Config file updaters (Node.js process — not OS-sandboxed) ─────────────────

function getConfigPaths(cwd: string): {
  globalPath: string;
  projectPath: string;
} {
  return {
    globalPath: join(homedir(), ".pi", "agent", "sandbox.json"),
    projectPath: join(cwd, ".pi", "sandbox.json"),
  };
}

function readOrEmptyConfig(configPath: string): Partial<SandboxConfig> {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfigFile(configPath: string, config: Partial<SandboxConfig>): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function addDomainToConfig(configPath: string, domain: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.network?.allowedDomains ?? [];
  if (!existing.includes(domain)) {
    config.network = {
      ...config.network,
      allowedDomains: [...existing, domain],
      deniedDomains: config.network?.deniedDomains ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

function addReadPathToConfig(configPath: string, pathToAdd: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.filesystem?.allowRead ?? [];
  if (!existing.includes(pathToAdd)) {
    config.filesystem = {
      ...config.filesystem,
      allowRead: [...existing, pathToAdd],
      denyRead: config.filesystem?.denyRead ?? [],
      allowWrite: config.filesystem?.allowWrite ?? [],
      denyWrite: config.filesystem?.denyWrite ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

function addWritePathToConfig(configPath: string, pathToAdd: string): void {
  const config = readOrEmptyConfig(configPath);
  const existing = config.filesystem?.allowWrite ?? [];
  if (!existing.includes(pathToAdd)) {
    config.filesystem = {
      ...config.filesystem,
      allowWrite: [...existing, pathToAdd],
      denyRead: config.filesystem?.denyRead ?? [],
      denyWrite: config.filesystem?.denyWrite ?? [],
    };
    writeConfigFile(configPath, config);
  }
}

// ── Sandboxed bash ops ────────────────────────────────────────────────────────

/**
 * Run a command using BashOperations.exec and collect output into a BashResult.
 * Used in user_bash where we need full execution control for write-block retry,
 * but executeBashWithOperations is not in the public API.
 */
async function runWithOps(
  command: string,
  cwd: string,
  ops: BashOperations,
  signal?: AbortSignal,
): Promise<{ output: string; exitCode: number | undefined; cancelled: boolean; truncated: false }> {
  const chunks: Buffer[] = [];
  let cancelled = false;
  try {
    const r = await ops.exec(command, cwd, { onData: (d) => chunks.push(d), signal });
    return {
      output: Buffer.concat(chunks).toString("utf8"),
      exitCode: r.exitCode ?? undefined,
      cancelled: false,
      truncated: false,
    };
  } catch (err) {
    cancelled = (err instanceof Error && err.message === "aborted") || (signal?.aborted ?? false);
    return {
      output: Buffer.concat(chunks).toString("utf8"),
      exitCode: undefined,
      cancelled,
      truncated: false,
    };
  }
}

function createSandboxedBashOps(): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (!existsSync(cwd)) {
        throw new Error(`Working directory does not exist: ${cwd}`);
      }

      const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

      return new Promise((resolve, reject) => {
        const child = spawn("bash", ["-c", wrappedCommand], {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                child.kill("SIGKILL");
              }
            }
          }, timeout * 1000);
        }

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (err) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          reject(err);
        });

        const onAbort = () => {
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        child.on("close", (code) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);

          if (signal?.aborted) {
            reject(new Error("aborted"));
          } else if (timedOut) {
            reject(new Error(`timeout:${timeout}`));
          } else {
            resolve({ exitCode: code });
          }
        });
      });
    },
  };
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Disable OS-level sandboxing for bash commands",
    type: "boolean",
    default: false,
  });

  const localCwd = process.cwd();

  let sandboxEnabled = false;
  let sandboxInitialized = false;
  let policyEnabled = false; // tracks whether path/network policy is active this session

  // Session-temporary allowances — held in JS memory, not accessible by the agent.
  // These are added on top of whatever is in the config files.
  const sessionAllowedDomains: string[] = [];
  const sessionAllowedReadPaths: string[] = [];
  const sessionAllowedWritePaths: string[] = [];

  // ── Effective config helpers ────────────────────────────────────────────────

  function getEffectiveAllowedDomains(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...(config.network?.allowedDomains ?? []), ...sessionAllowedDomains];
  }

  function getEffectiveAllowRead(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...(config.filesystem?.allowRead ?? []), ...sessionAllowedReadPaths];
  }

  function getEffectiveAllowWrite(cwd: string): string[] {
    const config = loadConfig(cwd);
    return [...(config.filesystem?.allowWrite ?? []), ...sessionAllowedWritePaths];
  }

  // ── Sandbox reinitialize ────────────────────────────────────────────────────
  // Called after granting a session/permanent allowance so the OS-level sandbox
  // picks up the new rules before the next bash subprocess starts.

  async function reinitializeSandbox(cwd: string): Promise<void> {
    if (!sandboxInitialized) return;
    const config = loadConfig(cwd);
    const configExt = config as unknown as { allowBrowserProcess?: boolean };
    try {
      await SandboxManager.reset();
      await SandboxManager.initialize({
        network: {
          ...config.network,
          allowedDomains: [...(config.network?.allowedDomains ?? []), ...sessionAllowedDomains],
          deniedDomains: config.network?.deniedDomains ?? [],
        },
        filesystem: {
          ...config.filesystem,
          denyRead: config.filesystem?.denyRead ?? [],
          allowRead: config.filesystem?.allowRead ?? [],
          allowWrite: [...(config.filesystem?.allowWrite ?? []), ...sessionAllowedWritePaths],
          denyWrite: config.filesystem?.denyWrite ?? [],
        },
        allowBrowserProcess: configExt.allowBrowserProcess,
        enableWeakerNetworkIsolation: true,
      });
    } catch (e) {
      console.error(`Warning: Failed to reinitialize sandbox: ${e}`);
    }
  }

  // ── UI prompts ──────────────────────────────────────────────────────────────

  async function promptDomainBlock(
    ctx: ExtensionContext,
    domain: string,
  ): Promise<"abort" | "session" | "project" | "global"> {
    if (!ctx.hasUI) return "abort";
    const choice = await ctx.ui.select(`🌐 Network blocked: "${domain}" is not in allowedDomains`, [
      "Abort (keep blocked)",
      "Allow for this session only",
      "Allow for this project  →  .pi/sandbox.json",
      "Allow for all projects  →  ~/.pi/agent/sandbox.json",
    ]);
    if (!choice || choice.startsWith("Abort")) return "abort";
    if (choice.startsWith("Allow for this session")) return "session";
    if (choice.startsWith("Allow for this project")) return "project";
    return "global";
  }

  async function promptReadBlock(
    ctx: ExtensionContext,
    filePath: string,
  ): Promise<"abort" | "session" | "project" | "global"> {
    if (!ctx.hasUI) return "abort";
    const choice = await ctx.ui.select(`📖 Read blocked: "${filePath}" is not in allowRead`, [
      "Abort (keep blocked)",
      "Allow for this session only",
      "Allow for this project  →  .pi/sandbox.json",
      "Allow for all projects  →  ~/.pi/agent/sandbox.json",
    ]);
    if (!choice || choice.startsWith("Abort")) return "abort";
    if (choice.startsWith("Allow for this session")) return "session";
    if (choice.startsWith("Allow for this project")) return "project";
    return "global";
  }

  async function promptWriteBlock(
    ctx: ExtensionContext,
    filePath: string,
  ): Promise<"abort" | "session" | "project" | "global"> {
    if (!ctx.hasUI) return "abort";
    const choice = await ctx.ui.select(`📝 Write blocked: "${filePath}" is not in allowWrite`, [
      "Abort (keep blocked)",
      "Allow for this session only",
      "Allow for this project  →  .pi/sandbox.json",
      "Allow for all projects  →  ~/.pi/agent/sandbox.json",
    ]);
    if (!choice || choice.startsWith("Abort")) return "abort";
    if (choice.startsWith("Allow for this session")) return "session";
    if (choice.startsWith("Allow for this project")) return "project";
    return "global";
  }

  // ── Apply allowance choices ─────────────────────────────────────────────────

  async function applyDomainChoice(
    choice: "session" | "project" | "global",
    domain: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!sessionAllowedDomains.includes(domain)) sessionAllowedDomains.push(domain);
    if (choice === "project") addDomainToConfig(projectPath, domain);
    if (choice === "global") addDomainToConfig(globalPath, domain);
    await reinitializeSandbox(cwd);
  }

  async function applyReadChoice(
    choice: "session" | "project" | "global",
    filePath: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!sessionAllowedReadPaths.includes(filePath)) sessionAllowedReadPaths.push(filePath);
    if (choice === "project") addReadPathToConfig(projectPath, filePath);
    if (choice === "global") addReadPathToConfig(globalPath, filePath);
    await reinitializeSandbox(cwd);
  }

  async function applyWriteChoice(
    choice: "session" | "project" | "global",
    filePath: string,
    cwd: string,
  ): Promise<void> {
    const { globalPath, projectPath } = getConfigPaths(cwd);
    if (!sessionAllowedWritePaths.includes(filePath)) sessionAllowedWritePaths.push(filePath);
    if (choice === "project") addWritePathToConfig(projectPath, filePath);
    if (choice === "global") addWritePathToConfig(globalPath, filePath);
    await reinitializeSandbox(cwd);
  }

  // ── user_bash — network pre-check + OS sandbox + write-block detection ──────
  //
  // Uses user_bash instead of registerTool to avoid replacing the bash tool
  // registration, which clashes with other extensions (e.g. tool-view).
  // When sandboxEnabled, we take full execution control via { result } so we
  // can detect OS-level write blocks and offer a retry in the same turn.

  pi.on("user_bash", async (event, ctx) => {
    // ── Network pre-check (policy layer, always runs when policy enabled) ──
    const config = loadConfig(ctx.cwd);
    if (policyEnabled) {
      const domains = extractDomainsFromCommand(event.command);
      const effectiveDomains = getEffectiveAllowedDomains(ctx.cwd);
      for (const domain of domains) {
        if (!domainIsAllowed(domain, effectiveDomains)) {
          const choice = await promptDomainBlock(ctx, domain);
          if (choice === "abort") {
            return {
              result: {
                output: `Blocked: "${domain}" is not in allowedDomains. Use /sandbox to review your config.`,
                exitCode: 1,
                cancelled: false,
                truncated: false,
              },
            };
          }
          await applyDomainChoice(choice, domain, ctx.cwd);
        }
      }
    }

    // ── OS-level sandbox: take over execution for write-block detection ──────
    if (!sandboxEnabled || !sandboxInitialized) {
      // OS sandbox off — let pi run bash normally (no registerTool override).
      return;
    }

    const ops = createSandboxedBashOps();

    const runSandboxed = () => runWithOps(event.command, localCwd, ops);

    const result = await runSandboxed();

    // Post-execution: detect OS-level write block and offer to allow + retry.
    if (ctx.hasUI) {
      const blockedPath = extractBlockedWritePath(result.output);
      if (blockedPath) {
        const choice = await promptWriteBlock(ctx, blockedPath);
        if (choice !== "abort") {
          await applyWriteChoice(choice, blockedPath, ctx.cwd);

          const freshConfig = loadConfig(ctx.cwd);
          const { projectPath, globalPath } = getConfigPaths(ctx.cwd);
          if (matchesPattern(blockedPath, freshConfig.filesystem?.denyWrite ?? [])) {
            ctx.ui.notify(
              `⚠️ "${blockedPath}" was added to allowWrite, but it is also in denyWrite and will remain blocked.\n` +
                `Check denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
              "warning",
            );
            return { result };
          }

          const retryResult = await runSandboxed();
          return {
            result: {
              ...retryResult,
              output: `--- Write access granted for "${blockedPath}", retrying ---\n${retryResult.output}`,
            },
          };
        }
      }
    }

    return { result };
  });

  // ── tool_call — network pre-check for bash, path policy for read/write/edit

  pi.on("tool_call", async (event, ctx) => {
    const config = loadConfig(ctx.cwd);
    if (!policyEnabled) return;

    const { projectPath, globalPath } = getConfigPaths(ctx.cwd);

    // Network pre-check for bash tool calls.
    if (sandboxEnabled && sandboxInitialized && isToolCallEventType("bash", event)) {
      const domains = extractDomainsFromCommand(event.input.command);
      const effectiveDomains = getEffectiveAllowedDomains(ctx.cwd);
      for (const domain of domains) {
        if (!domainIsAllowed(domain, effectiveDomains)) {
          const choice = await promptDomainBlock(ctx, domain);
          if (choice === "abort") {
            return {
              block: true,
              reason: `Network access to "${domain}" is blocked (not in allowedDomains).`,
            };
          }
          await applyDomainChoice(choice, domain, ctx.cwd);
        }
      }
    }

    // Path policy: read tool.
    //   - If the path is already in effectiveAllowRead, allow silently.
    //   - Otherwise always prompt, regardless of denyRead.
    //   - Granting (session or permanent) adds to allowRead, which overrides denyRead.
    //   - denyRead is never a hard-block on its own — it just sets the default
    //     denied state that the prompt can override.
    if (isToolCallEventType("read", event)) {
      const filePath = event.input.path;
      const effectiveAllowRead = getEffectiveAllowRead(ctx.cwd);

      if (!matchesPattern(filePath, effectiveAllowRead)) {
        const choice = await promptReadBlock(ctx, filePath);
        if (choice === "abort") {
          return {
            block: true,
            reason: `Sandbox: read access denied for "${filePath}"`,
          };
        }
        await applyReadChoice(choice, filePath, ctx.cwd);
        // Allowed — fall through, tool runs.
        return;
      }
    }

    // Path policy: write/edit — prompt for allowWrite, hard-block for denyWrite.
    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      const path = (event.input as { path: string }).path;
      const allowWrite = getEffectiveAllowWrite(ctx.cwd);
      const denyWrite = config.filesystem?.denyWrite ?? [];

      if (allowWrite.length > 0 && !matchesPattern(path, allowWrite)) {
        const choice = await promptWriteBlock(ctx, path);
        if (choice === "abort") {
          return {
            block: true,
            reason: `Sandbox: write access denied for "${path}" (not in allowWrite)`,
          };
        }
        await applyWriteChoice(choice, path, ctx.cwd);

        // denyWrite takes precedence — warn if it would still block.
        if (matchesPattern(path, denyWrite)) {
          ctx.ui.notify(
            `⚠️ "${path}" was added to allowWrite, but it is also in denyWrite and will remain blocked.\n` +
              `Check denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
            "warning",
          );
          return {
            block: true,
            reason: `Sandbox: write access denied for "${path}" (also in denyWrite)`,
          };
        }

        // Allowed — fall through, tool runs.
        return;
      }

      if (matchesPattern(path, denyWrite)) {
        return {
          block: true,
          reason:
            `Sandbox: write access denied for "${path}" (in denyWrite). ` +
            `To change this, edit denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
        };
      }
    }
  });

  // ── tool_result — agent bash write-block detection + retry signal ───────────
  //
  // tool_result fires after the agent's bash tool executes. We detect OS-level
  // write blocks and prompt the user. Unlike user_bash we can't re-run the
  // command here, so we modify the result content to instruct the LLM to retry.

  pi.on("tool_result", async (event, ctx) => {
    if (!sandboxEnabled || !sandboxInitialized) return;
    if (event.toolName !== "bash") return;
    if (!ctx.hasUI) return;

    const outputText = event.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n");

    const blockedPath = extractBlockedWritePath(outputText);
    if (!blockedPath) return;

    const choice = await promptWriteBlock(ctx, blockedPath);
    if (choice === "abort") return;

    await applyWriteChoice(choice, blockedPath, ctx.cwd);

    const freshConfig = loadConfig(ctx.cwd);
    const { projectPath, globalPath } = getConfigPaths(ctx.cwd);
    if (matchesPattern(blockedPath, freshConfig.filesystem?.denyWrite ?? [])) {
      ctx.ui.notify(
        `⚠️ "${blockedPath}" was added to allowWrite, but it is also in denyWrite and will remain blocked.\n` +
          `Check denyWrite in:\n  ${projectPath}\n  ${globalPath}`,
        "warning",
      );
      return;
    }

    // Can't re-execute here — tell the LLM to retry.
    return {
      content: [
        {
          type: "text" as const,
          text:
            outputText +
            `\n\n[Sandbox] Write access granted for "${blockedPath}". Please retry the command.`,
        },
      ],
    };
  });

  // ── session_start ───────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const noSandbox = pi.getFlag("no-sandbox") as boolean;

    if (noSandbox) {
      sandboxEnabled = false;
      policyEnabled = false;
      ctx.ui.notify("Sandbox: fully disabled via --no-sandbox", "warning");
      return;
    }

    const config = loadConfig(ctx.cwd);

    if (!config.enabled) {
      sandboxEnabled = false;
      policyEnabled = false;
      ctx.ui.notify("Sandbox disabled via config", "info");
      return;
    }

    // Policy is active whenever enabled:true, regardless of osSandbox.
    policyEnabled = true;

    if (config.osSandbox === false) {
      sandboxEnabled = false;
      ctx.ui.notify("Sandbox: OS-level disabled via osSandbox:false (path policy active)", "info");
      return;
    }

    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      sandboxEnabled = false;
      ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
      return;
    }

    try {
      const configExt = config as unknown as {
        ignoreViolations?: Record<string, string[]>;
        enableWeakerNestedSandbox?: boolean;
        allowBrowserProcess?: boolean;
      };

      await SandboxManager.initialize({
        network: config.network,
        filesystem: config.filesystem,
        ignoreViolations: configExt.ignoreViolations,
        enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
        allowBrowserProcess: configExt.allowBrowserProcess,
        enableWeakerNetworkIsolation: true,
      });

      // Make Node's built-in fetch() honour HTTP_PROXY / HTTPS_PROXY in this
      // process and any child processes that inherit the environment.
      // undici (which powers globalThis.fetch) ignores proxy env vars by default;
      // --use-env-proxy (Node 22+) opts it in. We set this here so that node
      // subprocesses spawned directly from bash (e.g. `node script.ts`) also
      // pick it up without needing to go through wrapWithSandbox.
      const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
      if (nodeMajor >= 22) {
        const existing = process.env.NODE_OPTIONS ?? "";
        process.env.NODE_OPTIONS = existing ? `${existing} --use-env-proxy` : "--use-env-proxy";
      }

      sandboxEnabled = true;
      sandboxInitialized = true;

      const networkCount = config.network?.allowedDomains?.length ?? 0;
      const writeCount = config.filesystem?.allowWrite?.length ?? 0;
      ctx.ui.setStatus(
        "sandbox",
        ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
      );
    } catch (err) {
      sandboxEnabled = false;
      ctx.ui.notify(
        `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
        "error",
      );
    }
  });

  // ── session_shutdown ────────────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    if (sandboxInitialized) {
      try {
        await SandboxManager.reset();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ── /sandbox command ────────────────────────────────────────────────────────

  pi.registerCommand("sandbox", {
    description: "Manage sandbox: /sandbox [on|off|status]",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();

      if (sub === "on") {
        if (sandboxEnabled) {
          ctx.ui.notify("Sandbox is already enabled", "info");
          return;
        }
        const config = loadConfig(ctx.cwd);
        const platform = process.platform;
        if (platform !== "darwin" && platform !== "linux") {
          ctx.ui.notify(`Sandbox not supported on ${platform}`, "warning");
          return;
        }
        try {
          const configExt = config as unknown as {
            ignoreViolations?: Record<string, string[]>;
            enableWeakerNestedSandbox?: boolean;
            allowBrowserProcess?: boolean;
          };
          await SandboxManager.initialize({
            network: config.network,
            filesystem: config.filesystem,
            ignoreViolations: configExt.ignoreViolations,
            enableWeakerNestedSandbox: configExt.enableWeakerNestedSandbox,
            allowBrowserProcess: configExt.allowBrowserProcess,
            enableWeakerNetworkIsolation: true,
          });
          sandboxEnabled = true;
          sandboxInitialized = true;
          policyEnabled = true;
          const networkCount = config.network?.allowedDomains?.length ?? 0;
          const writeCount = config.filesystem?.allowWrite?.length ?? 0;
          ctx.ui.setStatus(
            "sandbox",
            ctx.ui.theme.fg("accent", `🔒 Sandbox: ${networkCount} domains, ${writeCount} write paths`),
          );
          ctx.ui.notify("Sandbox enabled", "info");
        } catch (err) {
          ctx.ui.notify(
            `Sandbox initialization failed: ${err instanceof Error ? err.message : err}`,
            "error",
          );
        }
        return;
      }

      if (sub === "off") {
        if (!sandboxEnabled && !policyEnabled) {
          ctx.ui.notify("Sandbox is already disabled", "info");
          return;
        }
        if (sandboxInitialized) {
          try {
            await SandboxManager.reset();
          } catch {
            // Ignore cleanup errors
          }
        }
        sandboxEnabled = false;
        sandboxInitialized = false;
        policyEnabled = false;
        ctx.ui.setStatus("sandbox", "");
        ctx.ui.notify("Sandbox disabled", "info");
        return;
      }

      // default: show status
      if (sub && sub !== "status") {
        ctx.ui.notify(`Unknown subcommand "${sub}". Usage: /sandbox [on|off|status]`, "warning");
        return;
      }

      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled. Use /sandbox on to enable.", "info");
        return;
      }

      if (!sandboxEnabled) {
        ctx.ui.notify("Sandbox is disabled", "info");
        return;
      }

      const config = loadConfig(ctx.cwd);
      const { globalPath, projectPath } = getConfigPaths(ctx.cwd);

      const lines = [
        "Sandbox Configuration",
        `  Project config: ${projectPath}`,
        `  Global config:  ${globalPath}`,
        "",
        "Network (bash + !cmd):",
        `  Allowed domains: ${config.network?.allowedDomains?.join(", ") || "(none)"}`,
        `  Denied domains:  ${config.network?.deniedDomains?.join(", ") || "(none)"}`,
        ...(sessionAllowedDomains.length > 0
          ? [`  Session allowed: ${sessionAllowedDomains.join(", ")}`]
          : []),
        "",
        "Filesystem (bash + read/write/edit tools):",
        `  Deny Read:   ${config.filesystem?.denyRead?.join(", ") || "(none)"}`,
        `  Allow Read:  ${config.filesystem?.allowRead?.join(", ") || "(none)"}`,
        `  Allow Write: ${config.filesystem?.allowWrite?.join(", ") || "(none)"}`,
        `  Deny Write:  ${config.filesystem?.denyWrite?.join(", ") || "(none)"}`,
        ...(sessionAllowedReadPaths.length > 0
          ? [`  Session read:  ${sessionAllowedReadPaths.join(", ")}`]
          : []),
        ...(sessionAllowedWritePaths.length > 0
          ? [`  Session write: ${sessionAllowedWritePaths.join(", ")}`]
          : []),
        "",
        "Note: ALL reads are prompted unless the path is already in allowRead.",
        "Note: denyRead is not a hard-block — granting a prompt adds to allowRead, overriding denyRead.",
        "Note: denyWrite takes PRECEDENCE over allowWrite and is never prompted.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
