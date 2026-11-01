// Fictional demonstration case. Replace these records with A/B's agreed JSON later.
export const CASE_ID = 'CASE 2026-001';
export const EVIDENCE = [
  {
    id: 'E-01', title: '兼职招聘公告', kind: 'poster', date: '10月27日',
    subtitle: '校园宣传栏 · 招募材料', people: ['studio', 'zhang', 'chen'],
    summary: '招募方以“星跃工作室”名义发布兼职信息，并约定收取 500 元押金。',
    lines: ['校园活动协助人员招募', '工作内容：活动签到、场地引导与物料整理。', '报名保证金：500 元 / 人。活动结束后原路退还。', '招募方：星跃工作室。联系人：李老师。', '活动日期：10月29日。报名及缴费请联系群管理员。'],
    claims: [{ id: 'C-01', label: '押金退还承诺', text: '公告承诺：活动结束后原路退还每人 500 元押金。', quote: '活动结束后原路退还。' }]
  },
  {
    id: 'E-02', title: '退款承诺聊天记录', kind: 'chat', date: '10月30日',
    subtitle: '张同学与李老师 · 21:43—21:47', people: ['zhang', 'li'],
    summary: '李老师在周五晚称 500 元押金已经全部退还。',
    messages: [
      { speaker: '张同学', text: '活动结束了，请问我的 500 元押金什么时候退？', time: '21:43', self: true },
      { speaker: '李老师', text: '周五已经把 500 元全部退给你了，请注意查收。', time: '21:47', claim: 'C-02' },
      { speaker: '张同学', text: '我这里还没有看到，能发一下退款单号吗？', time: '21:48', self: true }
    ],
    claims: [{ id: 'C-02', label: '“周五已全额退款”', text: '10月30日（周五）21:47，李老师称 500 元押金已经全部退还。', quote: '周五已经把 500 元全部退给你了，请注意查收。' }]
  },
  {
    id: 'E-03', title: '转账记录截图', kind: 'receipt', date: '10月31日',
    subtitle: '张同学提供 · 退款到账凭证', people: ['zhang', 'li'],
    summary: '现有凭证显示 500 元于周六 17:35 到账，截图未展示完整交易附言。',
    fields: [['金额', '+ ¥500.00'], ['状态', '交易完成'], ['收款人', '张同学'], ['付款方显示名', '李某'], ['完成时间', '2026-10-31 17:35'], ['交易单号', 'R202610310017'], ['交易附言', '当前截图未展示']],
    claims: [{ id: 'C-03', label: '到账时间为次日', text: '凭证 E-03 显示 500 元于 10月31日 17:35 完成，仍需核实是否为同一笔押金。', quote: '2026-10-31 17:35' }]
  },
  {
    id: 'E-04', title: '报名群聊天记录', kind: 'chat', date: '10月28日',
    subtitle: '校园兼职群 · 收款账户讨论', people: ['studio', 'li', 'wang', 'chen'],
    summary: '群聊给出个人收款账户，尚缺少其与工作室关系的证明。',
    messages: [
      { speaker: '李老师', text: '活动由星跃工作室安排，保证金转给王某的账户，之后统一登记。', time: '16:08', claim: 'C-04' },
      { speaker: '陈同学', text: '王某是工作室的工作人员吗？', time: '16:12', self: true },
      { speaker: '王某', text: '我先协助登记，活动后会通知退费。', time: '16:15' }
    ],
    claims: [{ id: 'C-04', label: '收款主体关系待证明', text: '群聊提到“王某的账户”，但没有组织主体或授权关系证明。', quote: '保证金转给王某的账户' }]
  },
  {
    id: 'E-05', title: '支付平台退款回单', kind: 'supplement', date: '10月31日',
    subtitle: '补充材料 · 完整退款明细', people: ['zhang', 'li'], extra: true,
    summary: '完整回单将 E-03 的流水与本案押金对应起来，确认实际到账时间。',
    fields: [['交易单号', 'R202610310017'], ['对应报名记录', '张同学 · 10月29日校园活动'], ['退款项目', '报名保证金退还'], ['退款金额', '¥500.00'], ['实际到账', '2026-10-31 17:35'], ['付款方显示名', '李某'], ['工作室授权证明', '未附']],
    claims: [{ id: 'C-05', label: '确认同一笔押金退款', text: 'E-05 的交易单号与 E-03 一致，附言确认是本案 500 元押金退款，实际到账为 10月31日 17:35。', quote: '报名保证金退还' }]
  }
];

export const PEOPLE = [
  { id: 'zhang', name: '张同学', role: '兼职学生 · 申请退费', image: 'students.jpg', position: '20%', description: '提供聊天记录与到账截图。聊天中的说法和支付凭证需要分开核对。', evidence: ['E-01','E-02','E-03','E-05'] },
  { id: 'li', name: '李某 / 李老师', role: '自称招募负责人', image: 'contacts.jpg', position: '20%', description: '发布退费说法，付款账户显示名与其称呼有关联，但具体身份及授权仍待核实。', evidence: ['E-01','E-02','E-03','E-04'] },
  { id: 'wang', name: '王某', role: '收款与退费联系人 · 待核实', image: 'contacts.jpg', position: '77%', description: '群聊中被指定为收款账户持有人。现有材料没有证明其与工作室的正式关系。', evidence: ['E-04'] },
  { id: 'chen', name: '陈同学', role: '共同报名者 · 线索提供者', image: 'students.jpg', position: '80%', description: '在群内追问收款人的身份。尚未提供个人付款流水和完整证言。', evidence: ['E-01','E-04'] },
  { id: 'studio', name: '星跃工作室', role: '招募公告中的组织名称', image: 'campus.jpg', position: '50%', description: '名称出现在招募公告和群聊中。图片为地点示意，不构成该组织真实存在或承担责任的证明。', evidence: ['E-01','E-04'] }
];

export const TIMELINE = [
  { date: '10.27', time: '招募开始', title: '发布兼职公告', text: '公告约定 500 元保证金及原路退还规则。', evidence: 'E-01', type: '材料记载' },
  { date: '10.28', time: '16:08', title: '群内指定收款账户', text: '李老师要求转入王某账户，主体关系未说明。', evidence: 'E-04', type: '聊天记载' },
  { date: '10.30', time: '21:47', title: '声称周五已全部退款', text: '这是聊天中的说法，不能直接当作实际到账事实。', evidence: 'E-02', type: '人物说法', warning: true },
  { date: '10.31', time: '17:35', title: '凭证显示款项完成', text: '现有截图显示 500 元完成时间，需核对交易对应关系。', evidence: 'E-03', type: '支付凭证', warning: true },
  { date: '10.31', time: '补充回单', title: '完整回单确认退款项目', text: '单号与 E-03 一致，确认本案押金实际到账时间。', evidence: 'E-05', type: '补充材料', extra: true }
];

export const CLAIMS = EVIDENCE.flatMap(item => item.claims.map(claim => ({ ...claim, sourceId: item.id })));
