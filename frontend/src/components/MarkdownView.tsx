/**
 * MarkdownView — small, dependency-free renderer used by long-form in-product
 * docs (PROJECT_SHAPE primer, future references). Handles the markdown subset
 * the founder docs actually use: headings, paragraphs, ordered + unordered
 * lists, fenced code blocks, inline code, tables, blockquotes.
 *
 * Not a full CommonMark implementation. If a doc needs something this can't
 * render, the right fix is to simplify the doc — these are reference primers,
 * not literary essays.
 */

import { useMemo } from "react";

interface Props {
  src: string;
}

export function MarkdownView({ src }: Props) {
  const blocks = useMemo(() => tokenize(src), [src]);
  return (
    <div className="md-view">
      {blocks.map((b, i) => renderBlock(b, i))}
    </div>
  );
}

type Block =
  | { type: "h"; level: 1 | 2 | 3; text: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "pre"; code: string }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "quote"; text: string }
  | { type: "hr" };

function tokenize(src: string): Block[] {
  const lines = src.split(/\r?\n/);
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i];
    if (ln.trim() === "") { i++; continue; }

    // Fenced code block
    if (/^```/.test(ln)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // skip closing fence
      out.push({ type: "pre", code: buf.join("\n") });
      continue;
    }

    // Headings
    const m1 = ln.match(/^# (.+)/);
    if (m1) { out.push({ type: "h", level: 1, text: m1[1] }); i++; continue; }
    const m2 = ln.match(/^## (.+)/);
    if (m2) { out.push({ type: "h", level: 2, text: m2[1] }); i++; continue; }
    const m3 = ln.match(/^### (.+)/);
    if (m3) { out.push({ type: "h", level: 3, text: m3[1] }); i++; continue; }

    // Horizontal rule
    if (/^---+$/.test(ln.trim())) { out.push({ type: "hr" }); i++; continue; }

    // Blockquote
    if (/^> /.test(ln)) {
      const buf: string[] = [];
      while (i < lines.length && /^> /.test(lines[i])) { buf.push(lines[i].replace(/^> /, "")); i++; }
      out.push({ type: "quote", text: buf.join(" ") });
      continue;
    }

    // Table — header line | sep | sep
    if (/^\|.*\|$/.test(ln) && i + 1 < lines.length && /^\|[\s\-|:]+\|$/.test(lines[i + 1])) {
      const head = ln.split("|").slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i])) {
        rows.push(lines[i].split("|").slice(1, -1).map((c) => c.trim()));
        i++;
      }
      out.push({ type: "table", head, rows });
      continue;
    }

    // Ordered list
    if (/^\d+\.\s/.test(ln)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ""));
        i++;
      }
      out.push({ type: "ol", items });
      continue;
    }

    // Unordered list
    if (/^- /.test(ln) || /^\* /.test(ln)) {
      const items: string[] = [];
      while (i < lines.length && (/^- /.test(lines[i]) || /^\* /.test(lines[i]))) {
        items.push(lines[i].replace(/^[-*]\s/, ""));
        i++;
      }
      out.push({ type: "ul", items });
      continue;
    }

    // Paragraph — accumulate until blank line
    const buf: string[] = [ln];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#|>|-|\*|\d+\.\s|```|\|)/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push({ type: "p", text: buf.join(" ") });
  }
  return out;
}

function renderInline(text: string): { __html: string } {
  // Escape first, then re-introduce just the inline tokens we support.
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const withCode = escaped.replace(/`([^`]+)`/g, "<code>$1</code>");
  const withBold = withCode.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const withEm = withBold.replace(/(^|\W)_([^_]+)_(?=\W|$)/g, "$1<em>$2</em>");
  return { __html: withEm };
}

function renderBlock(b: Block, key: number) {
  if (b.type === "h" && b.level === 1) return <h1 key={key} dangerouslySetInnerHTML={renderInline(b.text)} />;
  if (b.type === "h" && b.level === 2) return <h2 key={key} dangerouslySetInnerHTML={renderInline(b.text)} />;
  if (b.type === "h") return <h3 key={key} dangerouslySetInnerHTML={renderInline(b.text)} />;
  if (b.type === "p") return <p key={key} dangerouslySetInnerHTML={renderInline(b.text)} />;
  if (b.type === "ul") return <ul key={key}>{b.items.map((it, i) => <li key={i} dangerouslySetInnerHTML={renderInline(it)} />)}</ul>;
  if (b.type === "ol") return <ol key={key}>{b.items.map((it, i) => <li key={i} dangerouslySetInnerHTML={renderInline(it)} />)}</ol>;
  if (b.type === "pre") return <pre key={key} className="md-pre"><code>{b.code}</code></pre>;
  if (b.type === "quote") return <blockquote key={key} dangerouslySetInnerHTML={renderInline(b.text)} />;
  if (b.type === "hr") return <hr key={key} />;
  if (b.type === "table") {
    return (
      <table key={key} className="md-table">
        <thead>
          <tr>{b.head.map((h, i) => <th key={i} dangerouslySetInnerHTML={renderInline(h)} />)}</tr>
        </thead>
        <tbody>
          {b.rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j} dangerouslySetInnerHTML={renderInline(c)} />)}</tr>
          ))}
        </tbody>
      </table>
    );
  }
  return null;
}
