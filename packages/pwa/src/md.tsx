// Minimal safe markdown renderer: builds React elements, never injects HTML.
// Supports: fenced code, inline code, bold, italic, links, headings, lists,
// blockquotes, hr. Good enough for chat answers; deliberately not a full md impl.
import type { ReactNode } from 'react';

const INLINE_PATTERN = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))/g;
const LINK_PATTERN = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE_PATTERN)) {
    const tok = m[0] ?? '';
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) {
      out.push(<code key={key} className="inline-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    } else {
      const lm = tok.match(LINK_PATTERN);
      if (lm) {
        out.push(
          <a key={key} href={lm[2]} target="_blank" rel="noreferrer noopener">
            {lm[1]}
          </a>,
        );
      } else {
        out.push(tok);
      }
    }
    last = start + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }): ReactNode {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // fenced code block
    if (line.trimStart().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        buf.push(lines[i] ?? '');
        i++;
      }
      i++; // closing fence (or EOF)
      blocks.push(
        <pre key={key++} className="code-block">
          {lang ? <div className="code-lang">{lang}</div> : null}
          <code>{buf.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1]?.length ?? 1;
      const Tag = (['h4', 'h4', 'h5', 'h5'][level - 1] ?? 'h5') as 'h4' | 'h5';
      blocks.push(<Tag key={key++}>{renderInline(h[2] ?? '', `h${key}`)}</Tag>);
      i++;
      continue;
    }

    // hr
    if (line.match(/^\s*([-*_])\1{2,}\s*$/)) {
      blocks.push(<hr key={key++} className="md-hr" />);
      i++;
      continue;
    }

    // unordered list
    if (line.match(/^\s*[-*+]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && (lines[i] ?? '').match(/^\s*[-*+]\s+/)) {
        items.push((lines[i] ?? '').replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++}>
          {items.map((it, n) => (
            <li key={n}>{renderInline(it, `ul${key}-${n}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // ordered list
    if (line.match(/^\s*\d+[.)]\s+/)) {
      const items: string[] = [];
      while (i < lines.length && (lines[i] ?? '').match(/^\s*\d+[.)]\s+/)) {
        items.push((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++}>
          {items.map((it, n) => (
            <li key={n}>{renderInline(it, `ol${key}-${n}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // blockquote
    if (line.match(/^\s*>\s?/)) {
      const buf: string[] = [];
      while (i < lines.length && (lines[i] ?? '').match(/^\s*>\s?/)) {
        buf.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote key={key++}>{renderInline(buf.join(' '), `bq${key}`)}</blockquote>,
      );
      continue;
    }

    // blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // paragraph: fold following non-special lines
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      !(lines[i] ?? '').match(/^\s*(?:[-*+]\s|\d+[.)]\s|>|#{1,4}\s|```)/)
    ) {
      buf.push(lines[i] ?? '');
      i++;
    }
    blocks.push(<p key={key++}>{renderInline(buf.join('\n'), `p${key}`)}</p>);
  }

  return <div className="md">{blocks}</div>;
}
