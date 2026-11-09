# Changelog

## 0.5.0

- Default the sidebar to current-workspace sessions and prioritize the current terminal folder.
- Add folder and agent grouping modes with workspace-persistent view preferences.
- Move history and folder-scope options into the Sessions overflow menu, with a Group By submenu.
- Use normal terminal icons for restored agent tabs instead of history-clock icons.

## 0.4.0

- Group sidebar sessions by working folder, with a persisted Show history checkbox.
- Browse native Codex, pi, Claude Code, and AGY history on demand.
- Enable or disable auto restore without stopping running agents; open history once without enabling it.
- Preserve old conversations when an observed terminal switches sessions or is closed.
- Create activated Python terminals through the optional public Python Environments API and wait for shell setup commands before starting agents.

## 0.3.2

- Prevent VS Code from creating a default shell before agent restoration by contributing `hideOnStartup: whenEmpty`.
- Create one normal shell when there are no restored terminals.
- Watch terminal creation throughout restoration and refocus the first restored agent after cleanup.

## 0.3.1

- Restore the optional **Add Session** sidebar action alongside automatic tracking.
- Browse local Codex/pi history or enter an existing session ID for any supported provider.

## 0.3.0 — Rekindle

- Introduce the Rekindle name, original icon, and English interface.
- Add automatic Claude Code and Antigravity CLI session observers and restoration.
- Start restoration earlier and conservatively clean up untouched startup shells.
- Preserve existing extension identity and workspace records during the rename.
- Add provider-hook tests, multi-provider restart tests, and a CI packaging template.

## 0.2.2

- Focus the first successfully restored agent terminal and reveal the Terminal panel.

## 0.2.1

- Restore agents inside the normal shell, preserving VS Code shell integration.

## 0.2.0

- Automatically observe ordinary Codex and pi terminals instead of requiring a manual restore list.

## 0.1.0

- Initial session restoration prototype.
