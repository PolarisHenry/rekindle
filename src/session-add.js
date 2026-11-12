'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { expandHome } = require('./core');
const { PROVIDERS } = require('./providers');

function resolveAddContext(target) {
  if (typeof target === 'string') return { cwd: target };
  if (!target || typeof target !== 'object') return {};
  const cwd = target.cwd || target.uri?.fsPath || target.fsPath;
  const provider = PROVIDERS.some(item => item.value === target.provider) ? target.provider : undefined;
  return { ...(cwd ? { cwd } : {}), ...(provider ? { provider } : {}) };
}

async function chooseProvider(vscode, preferred) {
  const context = resolveAddContext(preferred);
  const selected = PROVIDERS.find(item => item.value === context.provider);
  return selected || vscode.window.showQuickPick([...PROVIDERS], {
    title: 'Rekindle: Add Session', placeHolder: 'Choose an agent'
  });
}

async function dispatchAddHere(target, executeCommand) {
  return executeCommand('agentSessionRestore.add', target);
}

async function resolveWorkingDirectory(options) {
  const { cwd, folders, suggested, chooseDirectory, stat = fs.stat } = options;
  if (typeof cwd === 'string' && cwd.length > 0) {
    let directory;
    if (path.isAbsolute(cwd)) directory = await stat(cwd).catch(() => undefined);
    if (!directory?.isDirectory()) throw new Error(`The selected folder is unavailable: ${cwd}. Choose a valid folder and try again.`);
    return cwd;
  }
  return chooseDirectory(folders, suggested);
}

function directoryPickerItems(value, fixed, initial, recent, active) {
  const typed = expandHome(String(value || '').trim());
  const items = [];
  if (typed && path.isAbsolute(typed) && !fixed.includes(typed)) {
    items.push({ label: `$(folder) Use ${typed}`, typedPath: typed, description: 'Use the typed folder path', alwaysShow: true });
  }
  for (const cwd of fixed) items.push({ label: cwd, cwd, description: cwd === initial ? 'Current folder' : recent.includes(cwd) ? 'Recently used' : undefined });
  if (active && !fixed.includes(active)) items.push({ label: active, cwd: active, description: 'Active terminal folder' });
  items.push({ label: '$(folder-opened) Browse for any folder…', browse: true, description: 'Open the system folder picker', alwaysShow: true });
  return items;
}

// Folder selection without forcing the native open-file dialog: pick a listed
// folder (workspace, explicit context, active terminal, or recent), type or paste
// an absolute path, or fall back to the system picker via Browse. Only an explicit
// context (suggested) becomes the default; the active terminal folder is listed but
// never auto-selected, so the toolbar action stays isolated from prior adds.
function chooseDirectoryWithPicker(vscode, options = {}) {
  const { folders = [], suggested, active, recent = [], stat = fs.stat, openDialog } = options;
  const initial = typeof suggested === 'string' && suggested ? suggested : undefined;
  const activeFolder = typeof active === 'string' && path.isAbsolute(active) ? active : undefined;
  const fixed = [...new Set([initial, ...folders, ...recent.filter(item => !folders.includes(item) && item !== initial)].filter(Boolean))];
  return new Promise(resolve => {
    const picker = vscode.window.createQuickPick();
    picker.title = 'Conversation working directory';
    picker.placeholder = 'Pick a folder, or type/paste an absolute path (~ supported)';
    let result;
    let interacting = false;
    let hiddenDuringDialog = false;
    let settled = false;
    const build = () => { picker.items = directoryPickerItems(picker.value, fixed, initial, recent, activeFolder); };
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const subscription of subscriptions) subscription.dispose();
      picker.dispose();
      resolve(result);
    };
    const subscriptions = [
      picker.onDidChangeValue(() => { picker.validationMessage = undefined; build(); }),
      picker.onDidAccept(async () => {
        if (interacting) return;
        const item = picker.selectedItems[0] || picker.activeItems[0];
        if (!item) return;
        if (item.browse) {
          if (typeof openDialog !== 'function') return;
          interacting = true;
          picker.busy = true;
          let picked;
          let dialogError;
          try {
            picked = await openDialog(initial || folders[0]);
          } catch (error) {
            dialogError = error;
          } finally {
            picker.busy = false;
            interacting = false;
          }
          if (dialogError) {
            picker.validationMessage = `Could not open the folder picker: ${dialogError.message || dialogError}`;
            if (hiddenDuringDialog) {
              hiddenDuringDialog = false;
              picker.show();
            }
            return;
          }
          if (picked) {
            result = picked;
            if (hiddenDuringDialog) finish();
            else picker.hide();
          } else if (hiddenDuringDialog) {
            // Opening the native dialog can hide a QuickPick on some VS Code
            // versions. If the user cancels the dialog, let them keep choosing.
            hiddenDuringDialog = false;
            picker.show();
          }
          return;
        }
        if (item.typedPath) {
          const info = await stat(item.typedPath).catch(() => null);
          if (!info?.isDirectory()) { picker.validationMessage = `Not an existing folder: ${item.typedPath}`; return; }
          result = item.typedPath;
          picker.hide();
          return;
        }
        result = item.cwd;
        picker.hide();
      })
    ];
    subscriptions.push(picker.onDidHide(() => {
      if (interacting) {
        hiddenDuringDialog = true;
        return;
      }
      finish();
    }));
    build();
    picker.show();
  });
}

module.exports = { PROVIDERS, resolveAddContext, chooseProvider, dispatchAddHere, resolveWorkingDirectory, directoryPickerItems, chooseDirectoryWithPicker };
