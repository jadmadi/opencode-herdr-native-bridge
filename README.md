# opencode-herdr-native-bridge

Install this OpenCode V2 TUI plugin to show `opencode-native` in the Herdr TUI
(0.9.5) agents list with live `working`, `idle`, and `blocked` state.

It is only for `herdr` TUI 0.9.5 on Linux. If you use `herdr-app`, skip this
plugin because `opencode-native` already emits OSC 7501 directly.

## Install and use

Symlink the repo into OpenCode's plugins directory:

```sh
ln -s "$PWD" ~/.config/opencode/plugins/opencode-herdr-native-bridge
```

Or add the TUI entrypoint to `~/.config/opencode/tui.jsonc`:

```jsonc
{
  "plugin": [
    "./herdr-tui-session.js",
    "file:///path/to/opencode-herdr-native-bridge/tui.ts"
  ]
}
```

Launch `opencode-native` inside any Herdr TUI pane:

```sh
opencode-native -s <session-id>
```

The sidebar shows `opencode` by default. Set `HERDR_AGENT` to override it:

```sh
HERDR_AGENT=oc-ru opencode-native -s <session-id>
```

Tested against `opencode-native` `0.0.0-native-37` and `herdr` `0.9.5`. Pin a
release by checking out a tag such as `v2026.11.0` before linking.

## Why the bridge is needed and how it works

Without this bridge, four separate gaps drop `opencode-native` from the Herdr
TUI agents list:

| Side            | Gap                          | Bridge fix                 |
| --------------- | ---------------------------- | -------------------------- |
| opencode-native | Scrubs HERDR_* from host env | Reads /proc/<ppid>/environ |
| opencode-native | SIGKILLs host before cleanup | Releases via tail --pid    |
| herdr 0.9.5     | Misses opencode-native proc  | Reports directly over sock |
| herdr 0.9.5     | Drops herdr:opencode reports | Source "opencode:native"   |

Each step maps directly to those gaps:

1. Classic `opencode` keeps `HERDR_ENV`, `HERDR_SOCKET_PATH`, and
   `HERDR_PANE_ID` in `process.env`. When present, `setup(api)` exits so
   `herdr-opencode` keeps ownership.
2. When `opencode-native` strips them from the JS host, the bridge reads them
   (plus optional `HERDR_AGENT` and `HERDR_BIN_PATH`) from
   `/proc/<ppid>/environ`.
3. It tracks OpenCode router, session, permission, and form events, sending
   `pane.report_agent_session` and `pane.report_agent` over `HERDR_SOCKET_PATH`
   with `source: "opencode:native"`.
4. A detached `tail --pid=<ppid>` watcher runs `herdr pane release-agent` when
   `opencode-native` exits, returning the pane to a plain terminal.

## Limits and verification

- Requires Linux `/proc/<ppid>/environ` and `tail --pid`.
- Run `./script/check` (syntax check and `bun test`) to verify locally.

## License

AGPL-3.0-only. Copyright (C) 2026 Jad Madi.
