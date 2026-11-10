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
  if (phase === 'migration-seed') {
    const legacy = vscode.extensions.getExtension('local-tools.agent-session-restore');
    assert.ok(legacy, 'legacy identity is installed for the seed phase');
    assert.deepEqual(await legacy.activate(), { seeded: true, count: 2 });
    const replacement = vscode.extensions.getExtension('ArionLee.agent-session-restore');
    const blocked = await replacement.activate();
    assert.equal(blocked.blocked, true, 'the new identity blocks before registering duplicate commands');
    console.log('PASS legacy identity seeded workspaceState through the VS Code extension API');
    return;
  }
  const extension = vscode.extensions.getExtension('ArionLee.agent-session-restore');
  assert.ok(extension, 'extension is registered');
  const api = await extension.activate();
  await api.ready;
  const manager = api.manager;
  if (['migration-import', 'migration-reopen'].includes(phase)) {
    assert.equal(api.blocked, undefined, 'new identity was not blocked by the passive bridge');
    assert.equal(manager.entries.length, 2, `legacy records imported exactly once (migration=${api.migration?.status}, installed=${Boolean(vscode.extensions.getExtension('local-tools.agent-session-restore'))}, extensions=${vscode.extensions.all.map(item => item.id).filter(id => /local-tools|ArionLee/i.test(id)).join(',')})`);
    assert.equal(manager.entries.find(entry => entry.id === 'legacy-enabled-id').name, 'Legacy custom name');
    assert.equal(manager.entries.find(entry => entry.id === 'legacy-enabled-id').customName, true);
    assert.equal(manager.entries.find(entry => entry.id === 'legacy-enabled-id').enabled, true);
    const paused = manager.entries.find(entry => entry.id === 'legacy-disabled-id');
    assert.equal(paused.enabled, false);
    assert.equal(paused.archived, true);
    assert.equal(paused.sessionFile, path.join(data, 'workspace', 'legacy.pi.jsonl'));
    assert.equal(api.tree.showHistory, true);
    assert.equal(api.tree.groupBy, 'agent');
    assert.equal(api.tree.workspaceOnly, false);
    assert.equal(api.migration.status, phase === 'migration-import' ? 'imported' : 'already-imported');
    assert.equal(vscode.window.terminals.filter(terminal => terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID === 'legacy-disabled-id').length, 0, 'disabled legacy record is not restored');
    assert.ok(vscode.window.terminals.filter(terminal => terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID === 'legacy-enabled-id').length <= 1, 'enabled legacy record is restored at most once');
    console.log(`PASS legacy identity migration: ${phase}`);
    return;
  }
  async function launchOrdinaryAgent(name, args) {
    const terminal = vscode.window.createTerminal({name, cwd:path.join(data,'workspace')});
    await until(() => Boolean(terminal.shellIntegration));
    const cli = path.join(data, "fake agent's cli");
    terminal.shellIntegration.executeCommand([cli,...args].map(shellQuote).join(' '));
    return terminal;
  }
  if (phase === 'new-session') {
    for (const entry of [...manager.entries]) await manager.remove(entry.id);
    for (const terminal of [...vscode.window.terminals]) terminal.dispose();
    await new Promise(resolve => setTimeout(resolve,300));
    const old=await manager.add({provider:'codex',sessionId:'saved-old-id',cwd:path.join(data,'workspace')},'测试？？？');
    const terminal=await manager.create({provider:'codex',cwd:old.cwd},'测试');
    await until(async()=>{await api.tracker.sample();return manager.entries.length===2;});
    const created=manager.entries.find(entry=>entry.id!==old.id);
    assert.equal(created.name,'测试');
    assert.notEqual(created.sessionId,old.sessionId);
    assert.ok(created.sessionId);
    assert.equal(manager.live.get(created.id),terminal);
    const launches=(await fs.readFile(path.join(data,'launches.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(launches.at(-1).args,[],'new conversation does not run a resume command');
    await api.tree.setSearch('测试');
    assert.equal((await api.tree.getChildren()).flatMap(group=>group.sessions).length,2,'search finds both similar titles independently');
    console.log('PASS independent new conversation with similar Chinese names');
    return;
  }
  if (phase === 'features-seed') {
    const cwd=path.join(data,'workspace');
    const previousLaunches=(await fs.readFile(path.join(data,'launches.jsonl'),'utf8')).trim().split('\n').filter(Boolean).length;
    const feature=await manager.add({provider:'claude',sessionId:'feature-claude-exact-id',cwd,updatedAt:Date.now()-86400000},'Feature Claude');
    await manager.setSessionArguments(feature.id,['--model','feature-model']);
    await manager.setFavorite(feature.id,true);
    await manager.setEnabled(feature.id,false);
    const other=manager.entries.find(entry=>entry.id!==feature.id);
    const otherTerminal=other&&manager.live.get(other.id);
    await manager.open(feature);
    await until(async()=>{
      const rows=(await fs.readFile(path.join(data,'launches.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      return rows.some(row=>row.args.includes('--model')&&row.args[row.args.indexOf('--model')+1]==='feature-model'&&!row.args.includes('--permission-mode')&&row.args.includes('--resume')&&row.args[row.args.indexOf('--resume')+1]===feature.sessionId);
    });
    const beforeRestart=(await fs.readFile(path.join(data,'launches.jsonl'),'utf8')).trim().split('\n').filter(Boolean).length;
    await vscode.commands.executeCommand('agentSessionRestore.restart',feature);
    await until(async()=>{
      const rows=(await fs.readFile(path.join(data,'launches.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
      return rows.length>beforeRestart&&rows.at(-1).args.includes('--resume')&&rows.at(-1).args.at(-1)===feature.sessionId;
    });
    assert.equal(feature.enabled,false,'explicit Restart preserves disabled auto-restore');
    assert.equal(feature.favorite,true);
    assert.deepEqual(feature.sessionArguments,['--model','feature-model']);
    assert.ok(otherTerminal&&vscode.window.terminals.includes(otherTerminal),'Restart affects only the selected terminal');

    const old=await manager.add({provider:'codex',sessionId:'feature-old-history',cwd,updatedAt:Date.now()-40*86400000},'Old history',false);
    const recent=await manager.add({provider:'codex',sessionId:'feature-recent-history',cwd,updatedAt:Date.now()-2*86400000},'Recent history',false);
    await api.tree.setShowHistory(true);
    await api.tree.setHistoryRange(7);
    const withinSeven=(await api.tree.getChildren()).flatMap(group=>group.sessions);
    assert.ok(withinSeven.some(entry=>entry.sessionId===recent.sessionId));
    assert.ok(!withinSeven.some(entry=>entry.sessionId===old.sessionId));
    await api.tree.setHistoryRange('all');
    assert.ok((await api.tree.getChildren()).flatMap(group=>group.sessions).some(entry=>entry.sessionId===old.sessionId));
    await manager.hideFromHistory(old);
    assert.ok(!(await api.tree.getChildren()).flatMap(group=>group.sessions).some(entry=>entry.sessionId===old.sessionId));
    await manager.resetHiddenHistory();
    assert.ok((await api.tree.getChildren()).flatMap(group=>group.sessions).some(entry=>entry.sessionId===old.sessionId));
    await manager.hideFromHistory(old);
    await api.tree.setHistoryRange(7);

    await api.tree.setGrouping('folder');
    const folders=await api.tree.getChildren();
    assert.ok(folders.length);
    await api.tree.setExpanded(folders[0],false);
    await api.tree.setGrouping('agent');
    const agents=await api.tree.getChildren();
    assert.ok(agents.length);
    await api.tree.setExpanded(agents[0],true);
    await api.tree.setGrouping('folder');
    console.log('PASS feature state seed: session args, restart isolation, favorites, range, tombstones, grouping expansion.');
    return;
  }
  if (phase === 'features-reopen') {
    const feature=manager.entries.find(entry=>entry.sessionId==='feature-claude-exact-id');
    assert.ok(feature,'feature session persisted across VS Code restart');
    assert.equal(feature.enabled,false);
    assert.equal(feature.favorite,true);
    assert.deepEqual(feature.sessionArguments,['--model','feature-model']);
    assert.equal(api.tree.historyRangeDays,7);
    assert.ok(manager.hiddenHistory.has('codex:feature-old-history'));
    assert.equal(manager.live.has(feature.id),false,'disabled feature session is not automatically restored');
    assert.equal(api.tree.groupBy,'folder');
    const folders=await api.tree.getChildren();
    assert.equal(api.tree.expandedGroups.get(folders[0].groupId),false);
    await api.tree.setGrouping('agent');
    const agents=await api.tree.getChildren();
    assert.equal(api.tree.expandedGroups.get(agents[0].groupId),true);
    const oldTerminal=vscode.window.terminals.find(terminal=>terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID===feature.id);
    assert.equal(oldTerminal,undefined);
    console.log('PASS feature state reopen: overrides, hidden history, range, favorites, and expansion survive without restore.');
    return;
  }
  if (phase === 'environment-restore' || phase === 'disabled-restore') {
    assert.equal(manager.entries.length, 2);
    const first = manager.entries[0];
    const second = manager.entries[1];
    const root = await api.tree.getChildren();
    assert.ok(root.every(node=>node.kind==='folder'||node.kind==='agent'),'root contains only actual groups');
    for (const group of root) {
      const subgroups = await api.tree.getChildren(group);
      assert.ok(subgroups.length > 0);
      assert.ok(subgroups.every(child => child.kind === (group.kind === 'folder' ? 'agent' : 'folder')), 'second level uses the other grouping dimension');
      for (const subgroup of subgroups) {
        const groupItem = api.tree.getTreeItem(subgroup);
        assert.ok(groupItem.id);
        if (subgroup.kind === 'agent') {
          const icon = groupItem.iconPath;
          for (const uri of icon.light ? [icon.light,icon.dark] : [icon]) await fs.access(uri.fsPath);
        } else assert.equal(groupItem.iconPath.id,'folder');
        for (const leaf of await api.tree.getChildren(subgroup)) {
          assert.equal(leaf.kind, undefined);
          const item = api.tree.getTreeItem(leaf);
          assert.equal(item.iconPath.id,'circle-filled');
          assert.match(item.iconPath.color.id,/^terminal\.ansi/);
        }
      }
    }
    if (phase === 'environment-restore') {
      assert.ok(vscode.extensions.getExtension('ms-python.vscode-python-envs'), 'simulated Python API provider is available');
      await until(async()=> {
        const text=await fs.readFile(path.join(data,'launches.jsonl'),'utf8');
        return text.trim().split('\n').map(JSON.parse).slice(-2).every(row=>row.pythonEnv==='active');
      });
      const agents=vscode.window.terminals.filter(terminal=>terminal.name!=='zsh');
      assert.equal(agents.length,2,'source activation did not create extra agent terminals: '+vscode.window.terminals.map(terminal=>terminal.name).join(', '));
      await vscode.commands.executeCommand('agentSessionRestore.disable',first);
      assert.equal(first.enabled,false);
      assert.ok(vscode.window.terminals.includes(manager.live.get(first.id)),'disabling auto restore does not stop the running agent');
      const enabledFolders=(await api.tree.getChildren()).filter(node=>node.kind==='folder');
      assert.equal(enabledFolders.flatMap(folder=>folder.sessions).length,1,'default view hides paused conversations');
      await vscode.commands.executeCommand('agentSessionRestore.showHistory');
      const historicalFolders=(await api.tree.getChildren()).filter(node=>node.kind==='folder');
      const historicalRows=historicalFolders.flatMap(folder=>folder.sessions);
      assert.ok(historicalRows.length>=2,'Show history reveals the paused conversation');
      assert.ok(historicalRows.some(entry=>entry.id===first.id));
      const beforeSearch=historicalFolders.flatMap(folder=>folder.sessions).map(entry=>entry.id);
      await api.tree.setSearch(first.name);
      const matches=(await api.tree.getChildren()).flatMap(group=>group.sessions);
      assert.ok(matches.some(entry=>entry.id===first.id));
      await vscode.commands.executeCommand('agentSessionRestore.clearSearch');
      assert.deepEqual((await api.tree.getChildren()).flatMap(group=>group.sessions).map(entry=>entry.id),beforeSearch);
      assert.equal(api.tree.getTreeItem(first).checkboxState,undefined,'session rows have no checkbox');
      api.tree.history=[];
      api.tree.loadedAt=Date.now();
      await vscode.commands.executeCommand('agentSessionRestore.showHistory');
      const allFolders=(await api.tree.getChildren()).filter(node=>node.kind==='folder');
      const allRows=allFolders.flatMap(folder=>folder.sessions);
      assert.ok(allRows.length>=2,'Show history reveals the paused conversation');
      assert.ok(allRows.some(entry=>entry.id===first.id));
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
      assert.equal(vscode.window.terminals.length,2,'opening history creates only its one selected terminal');
      assert.ok(manager.live.get(first.id),'history can be opened once');
      assert.equal(vscode.window.terminals.filter(terminal=>terminal.creationOptions.env?.AGENT_SESSION_RESTORE_ID===first.id).length,1,'history opening binds one terminal to its exact session');
      assert.ok(vscode.window.terminals.includes(manager.live.get(second.id)),'opening history leaves the enabled session alive');
      assert.equal(first.enabled,false,'opening history does not silently enable auto restore');
      await vscode.commands.executeCommand('agentSessionRestore.enable',first);
      assert.equal(first.enabled,true,'explicit action can re-enable auto restore');
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
        return launches.some(item=>item.args.includes('--resume') && item.args[item.args.indexOf('--resume')+1]===ids[0])
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
    const icon = terminal.creationOptions.iconPath;
    const paths = icon.light ? [icon.light.fsPath, icon.dark.fsPath] : [icon.fsPath];
    assert.ok(paths.every(file => file.includes(`${path.sep}media${path.sep}agents${path.sep}`)), 'agent tabs use bundled provider artwork');
    for (const file of paths) await fs.access(file);
    assert.equal(terminal.creationOptions.shellArgs, undefined, 'resume command must not replace the shell startup');
    assert.ok(terminal.shellIntegration, 'restored terminal retains VS Code shell integration');
    terminal.dispose();
  }
  console.log(`PASS ${phase}: exact arguments, cwd, terminal names, deduplication and persistent state.`);
};
