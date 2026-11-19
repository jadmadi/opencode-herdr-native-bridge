# opencode-herdr-native-bridge

An OpenCode V2 TUI plugin that makes `opencode-native` appear in the Herdr TUI
(0.9.5) agents list with live `working`, `idle`, and `blocked` state.

## Why it exists

Both sides drop the status link when running `opencode-native` inside Herdr TUI:

| Side            | Gap                          | Bridge behavior                |
| --------------- | ---------------------------- | ------------------------------ |
| opencode-native | Scrubs HERDR_* from host env | Reads /proc/<ppid>/environ     |
| opencode-native | SIGKILLs host before cleanup | Releases via tail --pid        |
| herdr 0.9.5     | Misses opencode-native proc  | Reports directly over socket   |
| herdr 0.9.5     | Drops herdr:opencode reports | Uses source "opencode:native"  |

Classic `opencode` keeps `HERDR_*` in `process.env`, so this plugin steps aside
and lets Herdr's built-in integration handle it.

## Install

Clone or symlink this directory into OpenCode's plugins directory:

```sh
ln -s "$PWD" ~/.config/opencode/plugins/opencode-herdr-native-bridge
```

Or add the TUI entrypoint explicitly in `~/.config/opencode/tui.jsonc`:

```jsonc
{
  "plugin": [
    "./herdr-tui-session.js",
    "file:///path/to/opencode-herdr-native-bridge/tui.ts"
  ]
}
```

Tested against `opencode-native` `0.0.0-native-37` and `herdr` `0.9.5`.

To pin a release, check out a tag such as `v2026.11.0` before linking.

## Use

Launch `opencode-native` inside any Herdr TUI pane:

```sh
opencode-native -s <session-id>
```

The agent appears as `opencode` by default. Set `HERDR_AGENT` to customize the
label in the Herdr sidebar:

```sh
HERDR_AGENT=oc-ru opencode-native -s <session-id>
```

## How it works

1. On `setup(api)`, if `HERDR_ENV`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID` are
   already set in `process.env`, the plugin exits so `herdr-opencode` owns it.
2. Otherwise it reads those variables (plus `HERDR_AGENT` and `HERDR_BIN_PATH`)
   from `/proc/<ppid>/environ`.
3. It watches OpenCode router and session/permission/form events and sends
   `pane.report_agent_session` and `pane.report_agent` to `HERDR_SOCKET_PATH`
   with `source: "opencode:native"`.
4. A detached `tail --pid=<ppid>` watcher runs `herdr pane release-agent` as
   soon as `opencode-native` exits, clearing the pane back to a plain terminal.

## Requirements

- Linux (`/proc/<ppid>/environ` and `tail --pid` support).
- Herdr TUI (`herdr` 0.9.5). Users on `herdr-app` (`herdr-core`) do not need this plugin because `opencode-native` emits OSC 7501 natively.

## Tests

```sh
./script/check
```

## License

AGPL-3.0-only. Copyright (C) 2026 Jad Madi.
