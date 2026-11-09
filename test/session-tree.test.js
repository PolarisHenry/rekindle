'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { groupedSessions } = require('../src/session-tree');
const row = (id, cwd, enabled = true) => ({ id, provider: 'pi', sessionId: id, name: id, cwd, enabled });

test('default sidebar groups only enabled sessions by their actual folder', () => {
  const groups = groupedSessions([row('a','/work/first'),row('b','/work/second'),row('c','/work/first',false)], [], false);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].sessions.map(entry => entry.id), ['a']);
  assert.equal(groups[1].cwd, '/work/second');
});

test('history merges native conversations without duplicating tracked sessions', () => {
  const tracked = [row('a','/work'),row('b','/work',false)];
  const history = [{ ...row('a','/work'), title: 'native title' }, { ...row('c','/other'), title: 'old conversation' }];
  const groups = groupedSessions(tracked, history, true);
  assert.equal(groups.flatMap(folder => folder.sessions).length, 3);
  assert.equal(groups.find(folder => folder.cwd === '/work').sessions[0].name, 'a');
  const native = groups.find(folder => folder.cwd === '/other').sessions[0];
  assert.equal(native.enabled, false);
  assert.equal(native.historyOnly, true);
});

test('workspace scope excludes unrelated folders without matching path prefixes', () => {
  const groups = groupedSessions([row('a','/work/app'), row('b','/work/app/sub'), row('c','/work/application')], [], false, { workspaceFolders: ['/work/app'] });
  assert.deepEqual(groups.flatMap(group => group.sessions.map(entry => entry.id)).sort(), ['a','b']);
});

test('all-folders mode still prioritizes the current terminal folder', () => {
  const groups = groupedSessions([row('a','/aaa/other'), row('z','/work/z-project'), row('b','/work/app')], [], false, {
    workspaceFolders: ['/work'], workspaceOnly: false, currentFolder: '/work/z-project'
  });
  assert.equal(groups[0].cwd, '/work/z-project');
  assert.equal(groups.at(-1).cwd, '/aaa/other');
});

test('agent grouping combines providers and prioritizes their current-folder sessions', () => {
  const tracked = [row('other','/work/other'), row('current','/work/current'), { ...row('claude','/work/current'), provider:'claude' }];
  const groups = groupedSessions(tracked, [], false, { groupBy:'agent', workspaceFolders:['/work'], currentFolder:'/work/current' });
  assert.equal(groups.length,2);
  assert.ok(groups.every(group => group.kind==='agent'));
  assert.equal(groups.find(group => group.provider==='pi').sessions[0].id,'current');
});
