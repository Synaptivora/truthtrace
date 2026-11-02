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

export function buildReport(state) {
  const items=EVIDENCE.filter(e=>!e.extra||state.extra);
  return ['# TruthTrace 调查报告','','校园兼职押金纠纷 · 虚构示例','','## 提取信息',...CLAIMS.filter(c=>items.some(e=>e.id===c.sourceId)).map(c=>`- [${c.sourceId}] ${c.text}`),'','## 待核查问题','- [E-02 / E-03] 退款说法与凭证日期不同，需核对是否为同一笔交易。',...(state.extra?['- [E-05] 示例回单与 E-03 单号一致，记载到账时间为 10月31日 17:35。延迟原因仍待核实。']:[]),'- [E-01 / E-04] 招募主体与收款账户的授权关系未证明。','','## 核查备注',state.note||'未填写。','','## 原始材料索引',...items.map(e=>`- ${e.id}：${e.title} / ${e.date}`)].join('\n');
}
