# AGENTS.md

Guidance for agents working in this repository.

Read `~/.agents/AGENTS.md` and `../AGENTS.md` before making changes.

## What this is

An OpenCode V2 TUI plugin (`tui.ts`) that bridges `opencode-native` panes to
Herdr TUI 0.9.5 over `HERDR_SOCKET_PATH`. Zero dependencies, MIT.

## Checks

```sh
./script/check
```

This runs `bun build --no-bundle tui.ts` and `bun test`.

## Constraints

- Keep the plugin dependency-free (Node built-ins only).
- Export `VERSION` matching `package.json.version`.
- Never activate when `HERDR_*` is already present in `process.env`, so classic
  `opencode` keeps using `herdr-opencode`.
- Always use a non-`herdr:*` source (`opencode:native`), because `herdr` 0.9.5
  drops `herdr:opencode` reports when `opencode-native` is in the pane.
- Keep line width under 80 characters, no bold, and no em dashes in markdown.
