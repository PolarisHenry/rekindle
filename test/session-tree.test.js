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
