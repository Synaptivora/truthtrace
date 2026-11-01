import { CLAIMS, EVIDENCE } from './case-data.mjs';

export function createState() {
  return { read: [], clues: [], stage: 0, extra: false, note: '', checks: [], positions: {} };
}

export function normalizeState(value) {
  const state = createState();
  if (!value || typeof value !== 'object') return state;
  state.extra = value.extra === true;
  const sources = EVIDENCE.filter(e => !e.extra || state.extra).map(e => e.id);
  state.read = [...new Set((Array.isArray(value.read) ? value.read : []).filter(id => sources.includes(id)))];
  state.clues = [...new Set((Array.isArray(value.clues) ? value.clues : []).filter(id => CLAIMS.some(c => c.id === id && sources.includes(c.sourceId))))];
  state.stage = [0, 1, 2].includes(value.stage) ? value.stage : 0;
  if (!state.clues.includes('C-02') || !state.clues.includes('C-03')) state.stage = 0;
  if (state.stage === 2 && (!state.extra || !state.clues.includes('C-05'))) state.stage = 1;
  state.note = typeof value.note === 'string' ? value.note.slice(0, 8000) : '';
  state.checks = (Array.isArray(value.checks) ? value.checks : []).filter(i => [0,1,2].includes(i));
  if (value.positions && typeof value.positions === 'object') {
    for (const [id, p] of Object.entries(value.positions)) {
      if (/^(node-[a-z]+|central-node)$/.test(id) && p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
        state.positions[id] = { x: Math.max(0, Math.min(1000, p.x)), y: Math.max(8, Math.min(500, p.y)) };
      }
    }
  }
  return state;
}

export function assessVerdict(state, choice) {
  if (state.stage === 2) return { ok: false, message: '这条时间线索已经复核，可以查看调查笔记。' };
  const needed = state.stage === 0 ? ['C-02','C-03'] : ['C-02','C-05'];
  if (needed.some(id => !state.clues.includes(id)) || (state.stage === 1 && !state.extra)) {
    return { ok: false, message: '先翻阅材料，把这两条关键线索摘录进线索簿。' };
  }
  if (choice !== 'supported') return { ok: false, message: choice === 'accuse'
    ? '现有材料不能证明主观欺骗或直接认定诈骗。试着把结论限定在证据能支持的范围内。'
    : '时间不同不等于材料作废。先核对款项、交易单号与时间含义。' };
  return { ok: true, stage: state.stage + 1, message: state.stage === 0
    ? '阶段判断已记录。下一步：补充完整回单，确认是不是同一笔押金。'
    : '复核完成：已确认同一笔押金于周六到账。主体身份及延迟原因仍待调查。' };
}

export function buildReport(state) {
  const clues = CLAIMS.filter(c => state.clues.includes(c.id));
  return [
    '# TruthTrace 调查笔记', '', '案件：校园兼职押金纠纷 / CASE 2026-001',
    '说明：虚构演示案件。该笔记整理材料与疑点，不作法律定性。', '',
    '## 已摘录线索', ...clues.map(c => `- [${c.sourceId} / ${c.id}] ${c.text}`), '',
    '## 阶段判断', state.stage === 0 ? '尚未记录。' : state.stage === 1
      ? 'E-02 与 E-03 的时间信息不同，尚需核实是否为同一笔交易。'
      : 'E-05 与 E-03 的单号一致，证明本案押金于10月31日17:35到账，与10月30日晚“已全部退还”的说法不一致。此结论不代表已认定欺骗行为。', '',
    '## 仍待核实', '- 星跃工作室的主体身份、与李某及王某账户的关系。',
    '- 实际退款申请时间、到账延迟原因及其他报名者的经历。', '',
    '## 我的观察', state.note || '暂未填写。', '',
    '## 原始材料索引', ...EVIDENCE.filter(e => !e.extra || state.extra).map(e => `- ${e.id}：${e.title} / ${e.date}`)
  ].join('\n');
}
