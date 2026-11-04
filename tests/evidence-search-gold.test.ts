import { expect,test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { EvidenceIndex } from '../src/lib/search';
import { segmentEvidence } from '../src/lib/evidence-index/segments';
// Synthetic lexical relevance labels, explicitly authored; no model judge.
const gold=[
 {query:'退款',texts:['甲说退钱尚未完成','乙确认退款40元'],relevant:[0,1]},
 {query:'到账',texts:['银行回单显示入账','客服表示未到账'],relevant:[0,1]},
 {query:'定金',texts:['合同记载订金100元','甲支付定金100元'],relevant:[0,1]},
 {query:'微信',texts:['WeChat消息中提到付款','微信截图文字模糊'],relevant:[0,1]},
 {query:'钉钉',texts:['DingTalk群聊记录','钉钉截图'],relevant:[0,1]},
 {query:'2026-11-04',texts:['约定2026-11-04退款','约定2026-11-05退款'],relevant:[0]},
 {query:'100元',texts:['只退40元','承诺退100元'],relevant:[1]},
 {query:'未到账',texts:['甲说已到账','乙说未到账'],relevant:[1]},
];
test('authored lexical gold Recall@5/10, negatives and nearby scope',()=>{
 const db=new DatabaseSync(':memory:');try{const index=new EvidenceIndex(db);let baseline=0,expanded=0,expected=0;
 for(const [n,g] of gold.entries()){
  const scope={caseId:`fictional-${n}`,evidenceId:'e',version:1};const segments=segmentEvidence({...scope,kind:'chat',content:g.texts.join('\n')});index.replaceVersion(scope,segments);
  const opts={authorizedVersions:[scope],topK:5};const ids=new Set(g.relevant.map(i=>segments[i].id));
  baseline+=index.search(g.query,opts).hits.filter(s=>ids.has(s.id)).length;
  const found=index.search(g.query,{...opts,expand:true});expanded+=found.hits.filter(s=>ids.has(s.id)).length;expected+=ids.size;
  expect(found.hits.every(s=>ids.has(s.id))).toBe(true);expect(found.hits.filter(s=>ids.has(s.id))).toHaveLength(ids.size);
  expect(index.search(g.query,{...opts,topK:10,expand:true}).hits.filter(s=>ids.has(s.id))).toHaveLength(ids.size);
  expect(index.nearby(segments[0].id,opts)).toHaveLength(2);expect(index.nearby(segments[0].id,{authorizedVersions:[]})).toEqual([]);
 }
 expect(expanded/expected).toBe(1);expect(baseline).toBeLessThan(expanded);
 console.log(JSON.stringify({dataset:'lexical-gold-v1',cases:gold.length,baselineRecallAt5:baseline/expected,expandedRecallAt5:expanded/expected,humanIndependentReview:false}));
 expect(()=>index.search('退款',{authorizedVersions:Array.from({length:257},()=>({caseId:'a',evidenceId:'e',version:1}))})).toThrow('split explicit scope batches');
 }finally{db.close();}
});
