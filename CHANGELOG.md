# Changelog

Notable changes to opencode-herdr-native-bridge. Versions use CalVer (YYYY.MM.MICRO).

## 2026.11.1

- Relicense from AGPL-3.0-only to MIT.

## 2026.11.0

- Initial release bridging `opencode-native` TUI panes to Herdr TUI 0.9.5.
- Reads `HERDR_*` coordinates from `/proc/<ppid>/environ`.
- Reports lifecycle state under `source: "opencode:native"` with `HERDR_AGENT` support.
- Releases pane agent ownership via `tail --pid` on parent process exit.
