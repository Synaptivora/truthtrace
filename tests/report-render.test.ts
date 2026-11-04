import {it,expect} from "vitest";
import {renderReport,reportDocument} from "../src/lib/report-render";
it("exports the same document without executing source HTML",()=>{
 const text='<script>alert(1)</script><img src=x onerror=alert(1)>\n中文'.repeat(1000);
 const report={schemaVersion:1 as const,caseId:null,generatedAt:"2026-11-04",mode:"rule",markdown:text};
 expect(renderReport(report,"markdown")).toBe(text);
 const html=renderReport(report,"html");expect(html).not.toContain("<script>");expect(html).not.toContain("<img ");expect(html).toContain("&lt;script&gt;");expect(html).toContain("default-src 'none'");
});
it('renders semantic headings, lists and paragraphs without markdown wrappers or active links',()=>{
 const html=renderReport({schemaVersion:1,caseId:'<img src=x>',generatedAt:'2026-11-04',mode:'model',markdown:'# 报告标题\n\n说明段落\n\n## 时间线\n- 第一个事件\n  - [e1] 引用原文\n\n## 空章节\n\n## 边界\n不代表已经核实\n[jump](javascript:alert(1))'},'html');
 expect(html).toContain('<h1>报告标题</h1>');expect(html).toContain('<h2>时间线</h2>');expect(html).toContain('<li>第一个事件<ul>');expect(html).toContain('<li>[e1] 引用原文</li>');expect(html).toContain('<p>说明段落</p>');expect(html).toContain('<h2>空章节</h2>');expect(html).not.toContain('<pre>');expect(html).not.toContain('<a ');expect(html).not.toContain('<img ');expect(html).toContain('@media print');expect(html).toContain('@media(max-width:600px)');
});

it('uses readable coverage and commitment labels while retaining reference metadata',()=>{
 const ref={evidenceId:'e',quote:'周五退款',provenance:{schemaVersion:2 as const,caseId:'case',evidenceId:'e',version:3,segmentId:'e@3:0',originalHash:'a'.repeat(64),parserVersion:'parser-2',locator:{type:'text_range' as const,start:0,end:4},verificationMethod:'exact_text' as const}};
 const document=reportDocument({caseId:'case',evidence:[{id:'e',name:'原文',kind:'text',mimeType:'text/plain',content:'周五退款',version:3,originalHash:'a'.repeat(64)}],analysis:{caseTitle:'虚构报告',summary:'仅原文',people:[],relationships:[],events:[],contradictions:[],commitments:[{id:'c',personId:'p',commitment:'承诺退款',dueLabel:'周五',status:'pending',evidenceRefs:[ref]}],evidenceGaps:[],generatedAt:'2026-11-04',analysisMode:'rule'},notice:{truncated:true,droppedEvidence:2,droppedImages:1,skipped:[{title:'虚构群',reason:'没有选中'}]}});
 const html=renderReport(document,'html');expect(html).toContain('待履行或待核对');expect(html).toContain('未送入本次分析的材料：2 份');expect(html).toContain('字符 0–4');expect(html).toContain('v3');expect(html).toContain('a'.repeat(64));expect(html).toContain('parser-2');expect(html).toContain('e@3:0');expect(html).not.toContain('text_range');expect(html).not.toContain('droppedEvidence');expect(html).not.toContain('记录状态：pending');
});
