# pi-codex-rotate

Manage multiple ChatGPT Codex OAuth accounts in Pi.

## Features

- multiple Codex OAuth accounts
- `/codex` management command
- refresh expiring tokens
- sync active accounts into Pi auth storage for built-in credential rotation
- import from `~/.codex/auth.json`
- import from `~/.antigravity_cockpit/codex_accounts`

## Install

```bash
pi install npm:pi-codex-rotate
```

Local development:

```bash
pi install /absolute/path/to/packages/pi-codex-rotate
```

Or load without installing:

```bash
pi -e /absolute/path/to/packages/pi-codex-rotate/extensions/index.ts
```

## Usage

```text
/codex add
/codex list
/codex status
/codex remove <index|email>
/codex enable <index|email>
/codex disable <index|email>
/codex import
/codex import-cockpit
/codex sync
```

## Storage

- accounts: `~/.pi/agent/codex-accounts.json`
- synced auth: `~/.pi/agent/auth.json`

Respects `PI_CODING_AGENT_DIR` when set.
