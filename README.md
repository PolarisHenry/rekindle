<h1 align="center">Rekindle</h1>
<p align="center"><strong>Your terminal agents, right where you left them.</strong></p>

Rekindle remembers the conversations running in your VS Code terminals and restores them when you reopen the workspace. Open a terminal and use your agent normally. There is no session picker to maintain.

## What it does

- Tracks each terminal's conversation ID, working directory, and title automatically.
- Restores the exact conversation, rather than whichever session was used most recently.
- Opens the Terminal panel and focuses the first successfully restored agent.
- Preserves normal shell integration by launching the agent inside your regular shell.
- Sets the default `terminal.integrated.hideOnStartup` to `whenEmpty`, preventing VS Code from creating a competing shell before agents restore. With no restored terminals, Rekindle opens one normal shell instead. Explicit user/workspace overrides still take precedence.
- Observes the entire restoration phase and removes only untouched, idle startup shells.
- Provides an English **Rekindle → Sessions** sidebar with Folder → Agent → Session or Agent → Folder → Session grouping. By default, it shows tracked sessions in the current workspace, prioritizing the current terminal folder.

## Optional manual sessions

Use the **+** button in the Rekindle sidebar or run **Rekindle: Add Session**. Choose a working folder or browse to any folder; the active terminal's current folder is suggested when available. Right-click a folder in Explorer or a Rekindle folder group and choose **New Agent Session Here** to use that folder directly. Each Folder or Agent group also has an inline **+** / **New Session Here** action; it carries that group's folder and agent into the picker. Starting from a folder skips the folder picker; a root Agent group without one folder and the toolbar action still open it. After choosing an agent, select **Create New Session** or a saved conversation. Similar or identical titles never merge different conversation IDs. You can also enter an exact saved session ID. New conversations inherit configured startup arguments and provider icon; automatic restoration becomes available once the CLI has saved its actual conversation ID.

## Agents

| Agent | How it is tracked | Restore command |
| --- | --- | --- |
| Codex | Process ancestry and open session files | `codex resume <id>` |
| pi | Local lifecycle extension (`agent_start` / `agent_settled`) | `pi --session <file>` |
| Claude Code | Local `SessionStart`, `UserPromptSubmit`, and `Stop` hooks | `claude --resume <id>` |
| Antigravity CLI / AGY | Local `SessionStart`, `PreInvocation`, and `Stop` hooks | `agy --conversation <id>` |

Automatic tracking is currently implemented for **macOS**. Other platforms are not yet supported by the process observer.

## Install

Build a VSIX locally:

```sh
npm ci
npm run package
code --install-extension rekindle.vsix
```

Load the updated extension, then use a normal terminal. Existing pi processes need one `/reload` after initial installation to load the observer. Claude Code and AGY load their hooks in a new CLI session; existing sessions follow their CLI's hook-reload rules. An agent must save a conversation before its history can be restored.

The package identifier and settings namespace remain `local-tools.agent-session-restore` / `agentSessionRestore.*` so upgrades retain existing workspace records. Its visible name, sidebar, commands, logs, and settings text are **Rekindle**, in English.

## Sidebar and history

Open the Sessions header's **…** menu for view options:

- **Show History / Hide History:** include automatically archived records and additional saved local conversations from Codex, pi, Claude Code, and AGY. Off by default.
- **Show All Folders / Current Workspace Only:** restrict the list to the open workspace folders by default, or browse conversations from other projects.
- **Group By → By Folder / By Agent:** choose **Folder → Agent → Session** or **Agent → Folder → Session**. Both modes retain the second grouping level; folders use full paths for identity and tooltips.

The default view shows enabled sessions in the current workspace and its subfolders. **Show All Folders** broadens the scope; **Show History** also reveals paused, archived, and discovered conversations. The current terminal folder is prioritized. View choices are remembered per workspace and shown in the view description. These display filters do not change which enabled sessions restore at startup. History is loaded on demand, cached briefly, and can be updated with **Refresh History**.

- **Search Sessions (magnifying glass):** filter names, agent labels, full paths, and session IDs as you type. Enter keeps the filter, Escape cancels the edit, and **Clear Search** removes it. Searches respect the current workspace/history scope.
- **Enable Auto Restore / Disable Auto Restore:** use the row action or context menu to control restoration on the next workspace startup. There are no checkboxes. Disabling does not stop a running agent; its row is hidden until **Show History** is enabled.
- Session rows show **Working** only for supported pi, Claude Code, AGY, and Codex lifecycle events. Rekindle also sends VS Code's OSC 9;4 progress signal to the exact terminal PTY, so the terminal-tab description can show progress without changing its title or focusing it. An open but idle terminal has no running label. Set `agentSessionRestore.completionNotifications` to enable one non-focusing notification when a supported agent finishes; it is off by default.
- **Click a session or Open Session:** opens it now. Opening a historical session once does not enable automatic restoration.
- **… → Show History:** reveals automatically archived conversations and additional native history so they can be opened or enabled again.
- Switching conversations in an observed terminal archives the old conversation rather than overwriting its record.

## Python environment activation

When the Python Environments extension is available and automatic activation is enabled, Rekindle uses its public API to create a terminal with the selected project environment activated **before** launching the agent. A `source .../.venv/bin/activate` command therefore runs in the shell, not inside the agent's prompt.

For ordinary or revived terminals, Rekindle also observes shell command start/end events and waits for startup commands to finish. A long-running setup command defers restoration rather than receiving the agent command as input. Python remains optional; projects without the extension use normal shells. If a compatible provider API is unavailable, Rekindle falls back to tracking startup shell commands. No global Python activation settings are changed.

## Everyday behavior

Closing VS Code preserves tracked sessions. Reopening the same workspace restores their saved conversation history. It does **not** keep closed agents running in the background or automatically send another prompt.

Deleting a terminal using its trash button disables its automatic restore and keeps its tracked row visible. Exiting an agent back to a regular shell archives its record after roughly ten seconds. **Forget Session** removes Rekindle's mapping without deleting the native CLI conversation; native history can still show that conversation.

## Settings

Agent groups and restored terminal tabs use bundled provider artwork; session leaves use small provider-colored dots. Codex uses the general OpenAI Blossom mark with light/dark theme variants; the other providers retain their original brand colors. The extension icon is bundled in the Marketplace package.

Rekindle adds `${progress}` to VS Code's default terminal-tab description template. This exposes busy/idle progress received through OSC 9;4, including for terminals with a custom tab title. An explicit `terminal.integrated.tabs.description` override remains in control; add `${progress}` to that template if you set one yourself. Rekindle does not write user settings.

The settings retain the `agentSessionRestore` prefix for upgrade compatibility:

| Setting | Default | Purpose |
| --- | --- | --- |
| `autoRestore` | `true` | Restore tracked terminals on workspace startup |
| `codexCommand` | `codex` | Executable name or absolute path |
| `piCommand` | `pi` | Executable name or absolute path |
| `claudeCommand` | `claude` | Executable name or absolute path |
| `agyCommand` | `agy` | Executable name or absolute path |
| `codexArguments` | `[]` | Extra Codex startup arguments |
| `piArguments` | `[]` | Extra pi startup arguments |
| `claudeArguments` | `[]` | Extra Claude Code startup arguments |
| `agyArguments` | `[]` | Extra AGY startup arguments |
| `codexHome` | empty | Override the Codex data directory |
| `piHome` | empty | Override the pi data directory |
| `claudeHome` | empty | Override the Claude history directory |
| `agyHome` | empty | Override the AGY history directory |

Executable settings accept paths, not shell command fragments or extra arguments. Use **Sessions → … → Agent Launch Settings** to configure extra arguments separately. Each array item is one argument; values containing spaces stay intact and are never evaluated as shell code.

For example, to restore Codex and AGY with your preferred permission flags, add these to your VS Code User Settings (JSON):

```json
{
  "agentSessionRestore.codexArguments": ["--yolo"],
  "agentSessionRestore.agyArguments": ["--dangerously-skip-permissions"]
}
```

This launches `codex --yolo resume <saved-id>` and `agy --dangerously-skip-permissions --conversation <saved-id>`. Argument defaults are empty; these settings apply to the next restored/opened terminal and do not restart running agents.

## Local observers

Rekindle installs a small local bridge for each event-based provider. Existing hook definitions are preserved; changed configuration files receive a timestamped backup.

- pi extension: `~/.pi/agent/extensions/vscode-agent-session-restore.ts`
- Claude Code: an observer appended to `hooks.SessionStart`, `hooks.UserPromptSubmit`, and `hooks.Stop` in its user settings (`CLAUDE_CONFIG_DIR` is respected)
- AGY: the `rekindle` definition in `~/.gemini/config/hooks.json`
- Shared observer script: `~/.local/share/rekindle/session-hook.cjs`
- Observer records: `~/.local/state/vscode-agent-session-restore/pi/`

Observer records contain process and session IDs, paths, provider, working state, and update time. They do not contain prompts, tool inputs, transcript contents, or credentials, and are not uploaded by Rekindle. Codex lifecycle extracts only `task_started` / `task_complete` event metadata from the exact rollout already associated with a terminal. A managed terminal can use its saved exact rollout if shared-daemon writer locks are ambiguous, after matching the rollout session ID and cwd; an unbound terminal never falls back to another session. Agent CLIs retain their normal authentication, network, hooks, and permission behavior. Rekindle only passes approval-bypass flags when you explicitly configure them.

On uninstall, remove the pi observer file, the two Claude hook entries whose command references `rekindle/session-hook.cjs`, the AGY `rekindle` definition, and the shared observer script/records if you no longer need them. Leave other hooks intact.

## Current limits

- Multiple Codex TUIs sharing a background daemon can be ambiguous. Rekindle skips a mapping it cannot identify instead of guessing. Independent `codex --no-daemon` processes avoid that ambiguity; Rekindle does not rewrite your launch command.
- Agent hooks/extensions must be enabled. Ephemeral sessions cannot be restored.
- Unsent input, in-flight tasks, scrollback, split layouts, and temporary CLI argument overrides are not restored.
- Terminals sharing the same title may not retain their original tab order.
- An extra shell that has been used or is running a child process is deliberately retained. Startup cleanup is conservative, not a global prohibition on ordinary terminals.

## Development

```sh
npm test
npm run test:integration
npm run package
```

Unit tests cover session identity, argument quoting, hook formats, merging existing configurations, process ownership, focus, and startup-shell safeguards. Integration tests use a real local VS Code installation with isolated user data and simulated agent processes, including the real hook reporter. Python activation tests run an actual shell `source` command through a simulated provider API and verify that agent processes inherit the activated environment. Sidebar tests verify both grouping levels, search, similar-name creation, historical visibility, stable sorting, one-time opening, and persisted enable/disable state. They restart VS Code to verify persistence and provider-specific restore arguments. No model calls are made. Set `VSCODE_EXECUTABLE_PATH` if VS Code is installed elsewhere.

A GitHub Actions example is included in `docs/ci.example.yml`. To enable it, move it to `.github/workflows/ci.yml` using an account token with workflow permissions.

The original mark is maintained as SVG plus a PNG extension icon. Regenerate it with `python3 scripts/make-icon.py` (requires Pillow).

### References

- [VS Code terminal API](https://code.visualstudio.com/api/references/vscode-api#TerminalOptions)
- [Codex CLI](https://learn.chatgpt.com/docs/cli/reference)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)
- [Antigravity hooks](https://antigravity.google/docs/hooks/)

MIT licensed.

### Icons on existing shells

VS Code's public Terminal API supplies icons at terminal creation but does not expose an icon setter for an existing terminal. The provider brand icon itself cannot be changed or animated through the supported API. Agent groups use provider artwork, session rows use provider-colored dots, and terminals created or restored by Rekindle keep their provider icon from launch. A manually opened zsh keeps its current terminal-tab icon when an agent is detected; Rekindle does not kill or replace a running shell to change its artwork. The separate VS Code progress status uses OSC 9;4 and `${progress}` in the tab description; it can display busy/idle state but does not rotate or replace the brand icon.
