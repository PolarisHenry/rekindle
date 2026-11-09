'use strict';
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

function unusedShell(terminal) {
  return /^(?:zsh|bash|sh|fish|pwsh|powershell)$/i.test(terminal.name)
    && terminal.state?.isInteractedWith === false
    && terminal.exitStatus === undefined
    && !terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID;
}

async function removeStartupShells(vscode, manager, candidates, log) {
  if (!manager.entries.some(entry => manager.live.has(entry.id))) return;
  let parents;
  try {
    const { stdout } = await execFile('ps', ['-axo', 'ppid='], { timeout: 3000 });
    parents = new Set(stdout.trim().split(/\s+/).map(Number));
  } catch { return; }
  const bound = new Set(manager.live.values());
  for (const terminal of candidates) {
    if (bound.has(terminal) || !vscode.window.terminals.includes(terminal) || !unusedShell(terminal)) continue;
    const pid = await terminal.processId;
    if (!pid || parents.has(pid)) continue; // A shell running any child process is never disposable.
    if (!unusedShell(terminal)) continue;
    terminal.dispose();
    log('Removed an unused shell created during startup.');
  }
}
module.exports = { unusedShell, removeStartupShells };
