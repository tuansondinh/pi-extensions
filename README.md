# pi-extensions

Monorepo for Pi-native extension packages.

## Packages

- `packages/pi-cache-timer`
- `packages/pi-secure-env-collect`
- `packages/pi-codex-rotate`

## Install published packages

```bash
pi install npm:pi-cache-timer
pi install npm:pi-secure-env-collect
pi install npm:pi-codex-rotate
```

## Install local package for development

```bash
pi install /absolute/path/to/pi-extensions/packages/pi-cache-timer
pi install /absolute/path/to/pi-extensions/packages/pi-secure-env-collect
pi install /absolute/path/to/pi-extensions/packages/pi-codex-rotate
```

## Workspace commands

```bash
npm run pack:all
```

Each package remains independently publishable on npm.
