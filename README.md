# pi-extensions

Monorepo for Pi-native extension packages.

## Packages

| Package | Description |
|---|---|
| [`pi-cache-timer`](packages/pi-cache-timer) | Footer timer showing elapsed time since last model response — tracks Anthropic prompt-cache window |
| [`pi-secure-env-collect`](packages/pi-secure-env-collect) | Masked interactive secret collection, writes to `.env`, Vercel, or Convex |
| [`pi-lazy-tools`](packages/pi-lazy-tools) | Hides all tools behind a manifest-aware `tool_search` gate — LLM enables tools by name on demand |

## Install

```bash
pi install npm:pi-cache-timer
pi install npm:pi-secure-env-collect
pi install npm:pi-lazy-tools
```

Local dev:

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-cache-timer
pi install /absolute/path/to/pi-extensions/packages/pi-secure-env-collect
pi install /absolute/path/to/pi-extensions/packages/pi-lazy-tools
```

## Workspace commands

```bash
npm run pack:all
```

Each package is independently publishable on npm.
