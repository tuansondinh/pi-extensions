# pi-cache-timer

Shows elapsed time since last model response in Pi footer. Useful for tracking Anthropic prompt-cache window.

## Install locally

```bash
pi install /absolute/path/to/packages/pi-cache-timer
```

Or load without installing:

```bash
pi -e /absolute/path/to/packages/pi-cache-timer/extensions/index.ts
```

## Behavior

- starts timer on `agent_end`
- clears timer on `agent_start`
- clears timer on `session_shutdown`
- green under 5 min
- yellow at 5–10 min
- red at 10+ min
- `/cache-timer` toggles enabled state
- persists toggle in `~/.pi/agent/settings.json` as `cacheTimer`

## Optional env

- `PI_DISABLE_CACHE_TIMER=1` — force disable
