import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, normalizeState, assessVerdict, buildReport } from '../dist/investigation.js';
import { EVIDENCE, CLAIMS } from '../dist/case-data.js';

test('没有摘录依据时不能跳过阶段判断', () => {
  assert.equal(assessVerdict(createState(), 'supported').ok, false);
});
test('初次比对只推进到待补证，指控性结论不会通过', () => {
  const state = { ...createState(), clues: ['C-02','C-03'] };
  assert.equal(assessVerdict(state, 'accuse').ok, false);
  assert.equal(assessVerdict(state, 'supported').stage, 1);
  assert.equal(state.stage, 0);
});
test('复核必须依赖已经加入且摘录的 E-05', () => {
  const state = { ...createState(), stage: 1, clues: ['C-02','C-03'] };
  assert.equal(assessVerdict(state, 'supported').ok, false);
  state.extra = true;
  state.clues.push('C-05');
  assert.equal(assessVerdict(state, 'supported').stage, 2);
});
test('恢复进度时移除不存在的来源、重复线索及未解锁的材料', () => {
  const state = normalizeState({ stage: 2, read: ['E-01','E-99'], clues: ['C-02','C-02','C-03','C-05'], extra: false });
  assert.deepEqual(state.read, ['E-01']);
  assert.deepEqual(state.clues, ['C-02','C-03']);
  assert.equal(state.stage, 1);
});
test('线索有真实数据来源，报告保留证据编号和未解决问题', () => {
  for (const claim of CLAIMS) assert.ok(EVIDENCE.some(e => e.id === claim.sourceId));
  const report = buildReport({ ...createState(), stage: 2, extra: true, clues: ['C-02','C-03','C-05'], note: '继续核查主体。' });
  assert.match(report, /E-05/);
  assert.match(report, /不代表已认定欺骗行为/);
  assert.match(report, /继续核查主体/);
  assert.match(report, /与李某及王某账户的关系/);
});
