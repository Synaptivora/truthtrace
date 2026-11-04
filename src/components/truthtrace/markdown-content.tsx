import { useMemo } from 'react';
import { renderMarkdown } from '@/lib/markdown';

export function MarkdownContent({text, className = ''}: {text:string; className?:string}) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`markdown-content ${className}`} dangerouslySetInnerHTML={{__html:html}} />;
}
