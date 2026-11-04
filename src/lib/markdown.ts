import { Marked, type Token } from 'marked';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
}

// Source fields are literal data, not report headings, links or embedded HTML.
export function markdownText(value: string): string {
  return escapeHtml(value).replace(/\r\n?/g, '\n').replace(/([\\`*{}\[\]#_|~])/g, '\\$1')
    .replace(/^(\s*)([-+])(?=\s)/gm, '$1\\$2').replace(/^(\s*\d+)([.)])(?=\s)/gm, '$1\\$2');
}
export function markdownItem(value: string): string {
  return '- ' + markdownText(value).replace(/\n/g, '\n  ');
}
export function markdownQuote(value: string): string {
  return markdownText(value).split('\n').map(line => '> ' + line).join('\n');
}

// One CommonMark/GFM renderer for reports, answers and document previews.
// HTML is displayed as text. Links/images never navigate or fetch remote content.
const markdown = new Marked({gfm:true, breaks:true, renderer:{
  html({text}) { return escapeHtml(text); },
  link({tokens, href}) { return `${this.parser.parseInline(tokens)} <span class="md-link-target">(${escapeHtml(href)})</span>`; },
  image({text}) { return `<span class="md-image-note">[图片：${escapeHtml(text || '未提供说明')}，请查看原始附件]</span>`; },
}});
export function renderMarkdown(value: string): string {
  return markdown.parse(value, {async:false});
}

// Preserve author/model formatting in prose, while exporting raw HTML as text.
// Token offsets are reconstructed within each parent; code spans/fences stay literal.
export function markdownProse(value: string): string {
  function safeRaw(token: Token): string {
    if(token.type === 'html')return escapeHtml(token.raw);
    if(token.type === 'image')return markdownText(`[图片：${token.text}，请查看原始附件]`);
    const children:Token[] = 'tokens' in token && Array.isArray(token.tokens) ? token.tokens
      : token.type === 'list' ? token.items
      : token.type === 'table' ? [...token.header,...token.rows.flat()].flatMap(cell=>cell.tokens) : [];
    let cursor=0, result='';
    for(const child of children){
      const index=token.raw.indexOf(child.raw,cursor);
      if(index<0)continue;
      result+=token.raw.slice(cursor,index)+safeRaw(child);cursor=index+child.raw.length;
    }
    return result+token.raw.slice(cursor);
  }
  return markdown.lexer(value).map(safeRaw).join('');
}
