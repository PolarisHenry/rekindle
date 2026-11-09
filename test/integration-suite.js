'use strict';
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { shellQuote } = require('../src/core');

async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for CLI launch');
}

exports.run = async function () {
  const phase = process.env.AGENT_RESTORE_TEST_PHASE;
  const data = process.env.AGENT_RESTORE_TEST_DATA;
  const extension = vscode.extensions.getExtension('local-tools.agent-session-restore');
  assert.ok(extension, 'extension is registered');
  const api = await extension.activate();
  await api.ready;
  const manager = api.manager;
  async function launchOrdinaryAgent(name, args) {
    const terminal = vscode.window.createTerminal({name, cwd:path.join(data,'workspace')});
    await until(() => Boolean(terminal.shellIntegration));
    const cli = path.join(data, "fake agent's cli");
    terminal.shellIntegration.executeCommand([cli,...args].map(shellQuote).join(' '));
    return terminal;
  }
  if (phase === 'environment-restore' || phase === 'disabled-restore') {
    assert.equal(manager.entries.length, 2);
    const first = manager.entries[0];
    const second = manager.entries[1];
    const root = await api.tree.getChildren();
    assert.ok(root.every(node=>node.kind==='folder'||node.kind==='agent'),'root contains only actual groups');
    if (phase === 'environment-restore') {
      assert.ok(vscode.extensions.getExtension('ms-python.vscode-python-envs'), 'simulated Python API provider is available');
      await until(async()=> {
        const text=await fs.readFile(path.join(data,'launches.jsonl'),'utf8');
        return text.trim().split('\n').map(JSON.parse).slice(-2).every(row=>row.pythonEnv==='active');
      });
      assert.equal(vscode.window.terminals.length,2,'source activation did not create extra terminals: '+vscode.window.terminals.map(terminal=>terminal.name).join(', '));
      await api.tree.checked({items:[[first,vscode.TreeItemCheckboxState.Unchecked]]});
      assert.equal(first.enabled,false);
      assert.ok(vscode.window.terminals.includes(manager.live.get(first.id)),'disabling auto restore does not stop the running agent');
      const enabledFolders=(await api.tree.getChildren()).filter(node=>node.kind==='folder');
      assert.equal(enabledFolders.flatMap(folder=>folder.sessions).length,1);
      api.tree.history=[];
      api.tree.loadedAt=Date.now();
      await vscode.commands.executeCommand('agentSessionRestore.showHistory');
      const allFolders=(await api.tree.getChildren()).filter(node=>node.kind==='folder');
      assert.equal(allFolders.flatMap(folder=>folder.sessions).length,2,'Show history reveals the paused conversation');
      await vscode.commands.executeCommand('agentSessionRestore.groupByAgent');
      assert.ok((await api.tree.getChildren()).every(node=>node.kind==='agent'));
      assert.ok(api.view.description.startsWith('By Agent'));
      await vscode.commands.executeCommand('agentSessionRestore.showAllFolders');
      assert.equal(api.tree.workspaceOnly,false);
      await vscode.commands.executeCommand('agentSessionRestore.workspaceOnly');
      assert.equal(api.tree.workspaceOnly,true);
    } else {
      assert.equal(first.enabled,false,'disabled flag persisted across application restart');
      assert.equal(api.tree.groupBy,'agent','grouping persists across restart');
      assert.equal(api.tree.workspaceOnly,true,'workspace scope persists across restart');
      assert.equal(api.tree.showHistory,true,'history menu choice persists across restart');
      assert.equal(vscode.window.terminals.length,1,'only the enabled conversation was restored');
      assert.equal(vscode.window.activeTerminal,manager.live.get(second.id));
      await manager.open(first);
      assert.equal(vscode.window.terminals.length,2,'history can be opened once');
      assert.equal(first.enabled,false,'opening history does not silently enable auto restore');
      await api.tree.checked({items:[[first,vscode.TreeItemCheckboxState.Checked]]});
      assert.equal(first.enabled,true,'checkbox can re-enable auto restore');
    }
    console.log('PASS activation ordering and sidebar state: '+phase);
    return;
  }
  if (phase.startsWith('multi-')) {
    const providers = ['claude', 'agy'];
    const ids = ['c3c3c3c3-3333-4333-8333-333333333333', 'd4d4d4d4-4444-4444-8444-444444444444'];
    if (phase === 'multi-seed') {
      for (const entry of [...manager.entries]) await manager.remove(entry.id);
      for (const terminal of [...vscode.window.terminals]) terminal.dispose();
      await new Promise(resolve => setTimeout(resolve, 300));
      await Promise.all(providers.map((provider,index)=>launchOrdinaryAgent(provider+' task',['hook',provider,ids[index]])));
      await until(async()=> { await api.tracker.sample(); return manager.entries.length === 2; });
      assert.deepEqual(manager.entries.map(entry=>entry.provider).sort(), ['agy','claude']);
      assert.deepEqual(manager.entries.map(entry=>entry.sessionId).sort(), ids);
    } else {
      assert.deepEqual(manager.entries.map(entry=>entry.sessionId).sort(),ids);
      assert.equal(vscode.window.terminals.length,2);
      await until(async()=> {
        const text=await fs.readFile(path.join(data,'launches.jsonl'),'utf8');
        const launches=text.trim().split('\n').map(JSON.parse);
        return launches.some(item=>item.args[0]==='--resume' && item.args[1]===ids[0])
          && launches.some(item=>item.args[0]==='--conversation' && item.args[1]===ids[1]);
      });
      await until(() => vscode.window.activeTerminal === manager.live.get(manager.entries[0].id));
      const { removeStartupShells } = require('../src/startup');
      const spare = vscode.window.createTerminal({ name: 'zsh' });
      await until(() => Boolean(spare.shellIntegration));
      await until(async () => {
        await removeStartupShells(vscode, manager, [spare], () => {});
        return !vscode.window.terminals.includes(spare);
      });
      assert.equal(vscode.window.terminals.length, 2, 'unused startup zsh was removed');
      const custom = vscode.window.createTerminal({ name: 'User shell' });
      await removeStartupShells(vscode, manager, [custom], () => {});
      assert.ok(vscode.window.terminals.includes(custom), 'a deliberately named user shell is preserved');
      custom.dispose();
      await until(() => !vscode.window.terminals.includes(custom));
    }
    console.log('PASS Claude / AGY hook tracking: '+phase);
    return;
  }
  if (phase.startsWith('auto-')) {
    const ids = ['a1a1a1a1-1111-4111-8111-111111111111', 'b2b2b2b2-2222-4222-8222-222222222222'];
    if (phase === 'auto-seed') {
      for (const entry of [...manager.entries]) await manager.remove(entry.id);
      for (const terminal of [...vscode.window.terminals]) terminal.dispose();
      await new Promise(resolve => setTimeout(resolve, 300));
      await Promise.all(ids.map((id,index)=>launchOrdinaryAgent('Ordinary terminal '+index,['capture',id])));
      await until(async()=> { await api.tracker.sample(); return manager.entries.length === 2; });
      assert.ok(manager.entries.every(entry=>entry.automatic));
      assert.deepEqual(manager.entries.map(entry=>entry.sessionId).sort(), ids);
    } else {
      assert.deepEqual(manager.entries.map(entry=>entry.sessionId).sort(),ids);
      assert.equal(vscode.window.terminals.length,2);
      await until(() => vscode.window.activeTerminal === manager.live.get(manager.entries[0].id));
      await until(async()=> {
        const text=await fs.readFile(path.join(data,'launches.jsonl'),'utf8');
        const launches=text.trim().split('\n').map(JSON.parse);
        return ids.every(id=>launches.some(item=>item.args[0]==='resume' && item.args[1]===id));
      });
    }
    console.log('PASS automatic ordinary-terminal tracking: '+phase);
    return;
  }
  if (phase === 'seed') {
    assert.equal(manager.entries.length, 0);
    assert.equal(vscode.workspace.getConfiguration('terminal.integrated').get('hideOnStartup'), 'whenEmpty');
    assert.equal(vscode.window.terminals.length, 1, 'no saved agent creates exactly one normal shell');
    await until(() => vscode.window.activeTerminal === vscode.window.terminals[0]);
    for (const terminal of [...vscode.window.terminals]) terminal.dispose();
    await until(() => vscode.window.terminals.length === 0);
    const codex = await manager.add({ provider: 'codex', sessionId: 'codex-exact-id', cwd: path.join(data, 'workspace') }, '库存 Codex');
    const pi = await manager.add({ provider: 'pi', sessionId: 'pi-exact-id', sessionFile: path.join(data, 'pi-session.jsonl'), cwd: path.join(data, 'workspace') }, '看板 pi');
    await Promise.all([manager.open(codex), manager.open(pi), manager.open(codex)]);
  } else {
    assert.equal(manager.entries.length, 2, 'workspace state survived a full application restart');
    assert.deepEqual(manager.entries.map(item => item.name), ['库存 Codex', '看板 pi']);
  }
  const expected = phase === 'seed' ? 2 : 4;
  let launches;
  await until(async () => {
    const text = await fs.readFile(path.join(data, 'launches.jsonl'), 'utf8').catch(() => '');
    launches = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return launches.length >= expected;
  });
  assert.equal(launches.length, expected);
  assert.equal(vscode.window.terminals.length, 2, 'no revived or duplicated shell terminals');
  const latest = launches.slice(-2);
  assert.deepEqual(latest.map(item => item.args).sort(), [['resume', 'codex-exact-id'], ['--session', path.join(data, 'pi-session.jsonl')]].sort());
  assert.equal(latest.every(item => item.cwd === path.join(data, 'workspace')), true);
  assert.notEqual(latest[0].id, latest[1].id);
  await vscode.commands.executeCommand('agentSessionRestore.restore');
  assert.equal(vscode.window.terminals.length, 2);
  await until(() => vscode.window.activeTerminal === manager.live.get(manager.entries[0].id));
  for (const terminal of vscode.window.terminals) {
    assert.equal(terminal.creationOptions.isTransient, true);
    assert.equal(terminal.creationOptions.iconPath.id, 'terminal', 'agent tabs use the normal terminal icon');
    assert.equal(terminal.creationOptions.shellArgs, undefined, 'resume command must not replace the shell startup');
    assert.ok(terminal.shellIntegration, 'restored terminal retains VS Code shell integration');
    terminal.dispose();
  }
  console.log(`PASS ${phase}: exact arguments, cwd, terminal names, deduplication and persistent state.`);
};
