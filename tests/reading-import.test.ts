import { afterEach, expect, it, vi } from 'vitest';
import { secureRoute } from '../src/lib/security/boundary';
import { renderMarkdown, markdownText, markdownQuote, markdownProse } from '../src/lib/markdown';
import { materialRequestBody, requestBodyLimit } from '../src/lib/request-limits';

afterEach(()=>vi.unstubAllEnvs());
it('accepts 3534 Chinese messages above 2 MiB without changing any byte',async()=>{
  vi.stubEnv('PORT','3000');vi.stubEnv('TRUTHTRACE_MACHINE_TOKEN','m'.repeat(64));
  const transcript=Array.from({length:3534},(_,i)=>`[2026-11-04 12:00:00] 甲: 消息${i} ${'合成测试文字'.repeat(36)}`).join('\n');
  const body=materialRequestBody({evidence:[{id:'chat',name:'合成记录',kind:'chat',mimeType:'text/plain',content:transcript}]});
  expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(2*1024*1024);
  const handler=vi.fn(async(request:Request)=>{expect((await request.json()).evidence[0].content).toBe(transcript);return Response.json({ok:true});});
  const route=secureRoute(handler);
  const request=(path:string)=>new Request(`http://127.0.0.1:3000${path}`,{method:'POST',headers:{host:'127.0.0.1:3000',authorization:`Bearer ${'m'.repeat(64)}`,'content-type':'application/json'},body});
  const accepted=await route(request('/api/analyze'));expect(accepted.status).toBe(200);await accepted.text();
  expect((await route(request('/api/source/extract'))).status).toBe(413);
  expect(handler).toHaveBeenCalledTimes(1);
});
it('keeps a finite material cap, exact routing and actionable size feedback',()=>{
  expect(requestBodyLimit('/api/analyze')).toBe(25*1024*1024);
  expect(requestBodyLimit('/api/cases-malicious')).toBe(2*1024*1024);
  expect(()=>materialRequestBody({content:'中'.repeat(9*1024*1024)})).toThrow(/25 MiB.*分批/);
});
it('renders tables, nested lists, emphasis, quotations and code as document structure',()=>{
  const html=renderMarkdown('# 标题\n\n**重点**\n\n| 项目 | 状态 |\n| --- | --- |\n| 付款 | 待核对 |\n\n1. 第一项\n   - 子项\n\n> 原文\n> 第二行\n\n```js\nconst n = 1 < 2;\n```');
  for(const tag of ['<h1>','<strong>','<table>','<ol>','<ul>','<blockquote>','<pre><code'])expect(html).toContain(tag);
  expect(html).toContain('1 &lt; 2');
});
it('does not create active HTML, remote images or unsafe links',()=>{
  const html=renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n![photo](https://private.invalid/tracker) [go](javascript:alert(1)) [encoded](jav&#x61;script:evil)');
  expect(html).not.toMatch(/<(script|img|iframe|a)\b/);expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('src="https://private.invalid');
});
it('keeps untrusted multiline quotes inside the quote rather than injecting report sections',()=>{
  const raw='原文\n# 伪造结论\n\n<script>bad</script>\n- 不是报告条目';
  const html=renderMarkdown(markdownQuote(raw));
  expect(html).toContain('<blockquote>');expect(html).not.toContain('<h1>');expect(html).not.toContain('<script>');
  expect(renderMarkdown(markdownText('记录.md · 2026-11-04'))).toContain('记录.md · 2026-11-04');
});
it('exports formatted prose without destroying code or allowing embedded HTML',()=>{
  const input='**重点**\n\n| 项目 | 状态 |\n| --- | --- |\n| 原件 | <img src=x> |\n\n- **嵌套** <script>bad</script>\n\n```html\n<img src=x>\n```\n\n`<b>代码</b>`';
  const output=markdownProse(input), html=renderMarkdown(output);
  expect(html).toContain('<table>');expect(html).toContain('<strong>重点</strong>');
  expect(output).toContain('```html\n<img src=x>\n```');
  expect(html).not.toMatch(/<(img|script)\b/);expect(html).toContain('<code>&lt;b&gt;代码&lt;/b&gt;</code>');
});
