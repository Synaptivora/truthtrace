import {test,expect,vi} from 'vitest';
import {analyzeFiles} from '../src/components/truthtrace/api-client';
test('analysis budget preserves all material and fallback notice',async()=>{
 const existing=Array.from({length:201},(_,i)=>({id:`e${i}`,kind:'text' as const,name:'fictional',mimeType:'text/plain',content:`fictional ${i}`}));
 const fresh={id:'new',kind:'text',name:'new',mimeType:'text/plain',content:'new fictional evidence'};
 const analysis={caseTitle:'fictional',summary:'unchecked',people:[],relationships:[],events:[],contradictions:[],commitments:[],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'};
 const fetcher=vi.fn().mockResolvedValueOnce(Response.json({evidence:[fresh]})).mockResolvedValueOnce(Response.json({analysis,meta:{analysisError:'fixture failure'}}));vi.stubGlobal('fetch',fetcher);
 try{const result=await analyzeFiles([],new AbortController().signal,()=>{},existing);expect(result.evidence).toEqual([...existing,fresh]);expect(JSON.parse(fetcher.mock.calls[1][1].body).evidence).toHaveLength(200);expect(result.notice?.note).toContain('fixture failure');expect(result.notice?.note).toContain('2 条尚未分析');expect(result.evidence.at(-1)?.version).toBeUndefined();}finally{vi.unstubAllGlobals();}
});
