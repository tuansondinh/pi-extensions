# pi-sandbox

> **Fork of [carderne/pi-sandbox](https://github.com/carderne/pi-sandbox)** — adds `osSandbox` config field to disable OS-level bash sandboxing while keeping the allow/deny/ask path policy active.

Sandbox for [pi](https://pi.dev/).

Sandboxes pi like this:
- **read/write/edit**: direct control using allow/deny/ask lists (path policy)
- **bash**: uses [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime) for OS-level network and filesystem access control

When a blocked action is attempted, the user is prompted to allow it temporarily or permanently rather than silently failing.

## Fork changes

Added `osSandbox` config field:

| Config | OS sandbox | Path policy (allow/deny/ask) |
|---|---|---|
| `enabled: true` (default) | ✅ | ✅ |
| `enabled: true, osSandbox: false` | ❌ | ✅ ← **new** |
| `enabled: false` | ❌ | ❌ |

This lets you run without OS-level bash restrictions (useful on unsupported platforms, CI, or when you just want the interactive prompt layer) while still enforcing read/write/network path policies.

## Configuration

Add a config to `~/.pi/agent/sandbox.json` (global) or `.pi/sandbox.json` (local). Local takes precedence.

```json
{
  "enabled": true,
  "osSandbox": false,
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["/Users", "/home"],
    "allowRead": [".", "~/.config", "~/.local"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

## Usage

```
pi -e ./sandbox                  # sandbox enabled (OS-level + path policy)
pi -e ./sandbox --no-sandbox     # OS-level disabled, path policy still active
/sandbox                         # show current sandbox configuration
/sandbox-enable                  # enable sandbox for this session
/sandbox-disable                 # disable sandbox for this session
```

## Precedence

- **Read**: `allowRead` overrides `denyRead` (prompt grant adds to `allowRead`)
- **Write**: `denyWrite` overrides `allowWrite` (most-specific deny wins)

## Notes

There is an example config at [sandbox.json](./sandbox.json). It has quite a few things added for [agent-browser](https://agent-browser.dev/) compatibility.

These open significant security loopholes, so shouldn't be used in a sensitive context or when you don't need browser support.

## Credits

Original work by [Chris Arderne](https://github.com/carderne), based on [Mario Zechner's](https://github.com/badlogic) sandbox extension. MIT License.
