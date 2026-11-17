'use strict';
const { t } = require('./localization');

async function createAgentTerminal(vscode, options, log, acquireApi, existing) {
  const extension = vscode.extensions?.getExtension('ms-python.vscode-python-envs');
  if (extension) {
    try {
      const uri = vscode.Uri.file(options.cwd);
      const activate = vscode.workspace.getConfiguration('python', uri).get('terminal.activateEnvironment', true);
      const mode = vscode.workspace.getConfiguration('python-envs', uri).get('terminal.autoActivationType');
      if (activate !== false && mode !== 'off') {
        const api = await (acquireApi ? acquireApi() : require('@vscode/python-environments').PythonEnvironments.api());
        if (typeof api.getEnvironment === 'function' && typeof api.createTerminal === 'function') {
          const environment = await api.getEnvironment(uri);
          if (environment) {
            // The provider owns activation and resolves only after setup. Avoid
            // competing with its delayed "source .../activate" injection.
            return await api.createTerminal(environment, options);
          }
        }
      }
    } catch (error) {
      log(`Python environment setup unavailable; using a regular shell: ${error.message}`);
      const created = vscode.window.terminals.find(terminal => terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID === options.env?.AGENT_SESSION_RESTORE_ID);
      if (created) return created;
    }
  }
  return existing || vscode.window.createTerminal(options);
}

class ShellGate {
  constructor(vscode) {
    this.vscode = vscode;
    this.state = new WeakMap();
    this.listeners = [];
    const start = vscode.window.onDidStartTerminalShellExecution;
    const end = vscode.window.onDidEndTerminalShellExecution;
    if (start) this.listeners.push(start(event => {
      const state = this.get(event.terminal);
      state.active.add(event.execution);
      state.last = Date.now();
    }));
    if (end) this.listeners.push(end(event => {
      const state = this.get(event.terminal);
      state.active.delete(event.execution);
      state.last = Date.now();
    }));
  }

  get(terminal) {
    if (!this.state.has(terminal)) this.state.set(terminal, { active: new Set(), last: 0 });
    return this.state.get(terminal);
  }

  async wait(terminal, { grace = 0, quiet = 250, timeout = 15000 } = {}) {
    const state = this.get(terminal);
    const notBefore = Date.now() + grace;
    const deadline = Date.now() + timeout;
    while (state.active.size || Date.now() < Math.max(notBefore, state.last + quiet)) {
      if (!this.vscode.window.terminals.includes(terminal)) throw new Error(t('Terminal closed before environment setup completed.'));
      if (Date.now() > deadline) throw new Error(t('Terminal is still running a setup command. Agent restore was deferred to avoid sending input into it.'));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  dispose() { this.listeners.forEach(listener => listener.dispose()); }
}
module.exports = { createAgentTerminal, ShellGate };
