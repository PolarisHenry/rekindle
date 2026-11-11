# Changelog

## 0.11.0

- Add persistent, clickable completion reminders to the status bar by default; optionally use native notifications or both, and clear pending reminders when disabled or opened.
- Keep native completion toasts compact and link-first; VS Code's close button still dismisses the toast without opening its session.
- Add a configurable pulse for working sessions, respecting the explicit workbench reduced-motion setting.

## 0.10.4

- Place Open Session first in a compact completion notification, keeping it clear of hover controls and truncation.
- Shorten long session names by display width and retain full names and folders in the link tooltip.

## 0.10.3

- Open completed sessions through a command link inside the notification instead of an auto-closing button, avoiding notification-close editor focus restoration.
- Reveal the target terminal once and ignore stale completion links whose saved conversation has changed or been removed.
- Verify maximized and manually resized panels retain their dimensions when opening completed sessions with an editor preview present.

## 0.10.2

- Focus the selected terminal when opening a session instead of leaving focus in the sidebar/editor.
- Keep session and folder ordering stable when opening or switching terminals; only real task activity changes recent-activity ordering.
- Preserve the current Working/Unknown state when revealing an existing terminal and avoid a full tree refresh for that action.

## 0.10.1

- Keep nested agent processes from replacing the outer terminal agent's saved conversation.
- Distinguish a restored agent waiting for its first lifecycle report from an unidentified process; preserve unknown task state until a real event arrives.
- Resolve relocated pi session files by exact identity and avoid tracking pi conversations before their session file is persisted.

## 0.10.0

- Make completion notifications actionable: each toast can open the exact saved session, and completed Codex turns remain deduplicated across a session restart.
- Show Open, Working, Unknown, and Restore Failed states with per-session diagnostics and retry for failed restores.
- Add per-session argument overrides, session actions, reversible favorites/history hiding, configurable history ranges, and per-group expansion memory.
- Sort favorites first, then by recent task activity or explicit opening; native history timestamps are preserved without promoting records when they are merely tracked.
- Keep cleanup limited to Rekindle metadata and hidden-history indexes; native CLI conversation files are never deleted.

## 0.9.3

- Enable non-focusing completion notifications by default and add an explicit Sessions menu toggle.
- Verify actual Codex lifecycle sampling clears Working and notifies once, including fast turns, while suppressing historical completions.

## 0.9.2

- Default Claude Code launches and restores to `--permission-mode bypassPermissions`; users can override with an empty argument array.

## 0.9.1

- Clarify personal Claude Code permission-mode argument formatting.
- Add the direct Marketplace publishing command and local authentication instructions.

## 0.9.0

- Publish under the confirmed `ArionLee.agent-session-restore` extension identity.
- Import saved sessions and sidebar preferences once from the passive `local-tools` migration bridge, scoped to the current workspace.
- Pause automatic restore when an older legacy extension is present, preventing duplicate restoration during the identity transition.

## 0.8.4

- Track task activity in managed Codex terminals when a shared daemon makes writer-lock mapping ambiguous, using only the exact saved rollout whose session metadata matches.
- Seed current Codex task state from lifecycle metadata across the rollout, including tasks whose start event is older than the output tail.

## 0.8.3

- Reuse an explicitly selected Folder/Explorer path when creating a new session, without reopening the directory picker.
- Clarify that the provider brand icon cannot rotate through the public Terminal API; task activity remains a separate native progress status.

## 0.8.2

- Show supported agent busy/idle state in terminal tabs using OSC 9;4 progress on the exact terminal TTY and VS Code's `${progress}` description variable.
- Add colored session dots and context-aware Add Session actions for Folder and Agent groups.

## 0.8.1

- Use provider-colored dots on session leaves while retaining official provider artwork on Agent groups and terminal tabs.
- Add context-aware New Session actions to Folder and Agent groups, carrying folder/provider through both grouping layouts.

## 0.8.0

- Default the sidebar to enabled sessions in the current workspace; expose paused sessions through Show History.
- Add folder-specific session creation from Explorer and folder groups, with cwd selection and arbitrary folder browsing.
- Preserve custom session names across automatic observation and explicitly rename an already tracked conversation when added again.
- Show task activity from provider lifecycle events and offer optional completion notifications, disabled by default.
- Replace Codex PNG artwork with bundled SVGs and document the public terminal icon setter limitation.

## 0.7.0

- Add explicit new-conversation creation, keeping similar names independent from existing saved conversations.
- Add live sidebar search across names, provider labels, full paths, and session IDs, with clear/cancel support.
- Remove session checkboxes; retain explicit enable/disable actions and stable ordering regardless of restore state.
- At 0.7.0, keep manually disabled sessions visible; 0.8.0 moves them behind the Show History filter.
- Start new agent terminals with provider icons and configured arguments, then bind actual IDs from the observer.

## 0.6.0

- Nest both grouping dimensions: Folder → Agent → Session or Agent → Folder → Session.
- Keep current-folder priority, history filters, enabled counts, and unique full-path group identities across both levels.
- Use bundled official Codex, pi, Claude Code, and Antigravity artwork in the sidebar and restored terminal tabs.

## 0.5.1

- Add per-agent startup argument arrays, including support for permission flags during exact-session restoration.
- Add Agent Launch Settings to the Sessions overflow menu.
- Quote each configured argument independently and validate values before launching.

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
