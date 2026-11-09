'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {descendants,parseProcesses,parseOpenFiles}=require('../src/automatic');
test('two ordinary terminal process trees remain distinct',()=>{
 const processes=parseProcesses(' 10 1 /bin/zsh\n 11 10 pi\n 20 1 /bin/zsh\n 21 20 codex\n 22 21 codex');
 assert.deepEqual([...descendants(10,processes)],[10,11]);
 assert.deepEqual([...descendants(20,processes)],[20,21,22]);
});
test('open session lock files retain the owning process identity',()=>{
 const files=parseOpenFiles('p11\nn/home/thread-writer-locks/a.lock\np21\nn/home/thread-writer-locks/b.lock');
 assert.deepEqual(files,[{pid:11,file:'/home/thread-writer-locks/a.lock'},{pid:21,file:'/home/thread-writer-locks/b.lock'}]);
});
