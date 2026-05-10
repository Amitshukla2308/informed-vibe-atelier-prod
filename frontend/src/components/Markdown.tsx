import type { ReactNode } from "react";

function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    if (m[2]) out.push(<strong key={`b${out.length}`}>{m[2]}</strong>);
    else if (m[3]) out.push(<em key={`i${out.length}`}>{m[3]}</em>);
    else if (m[4]) out.push(<em key={`i${out.length}`}>{m[4]}</em>);
    else if (m[5]) out.push(<code key={`c${out.length}`}>{m[5]}</code>);
    else if (m[6] && m[7]) out.push(<a key={`a${out.length}`} href={m[7]} target="_blank" rel="noreferrer">{m[6]}</a>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

function MdText({ src }: { src: string }) {
  const lines = src.split("\n");
  const out: ReactNode[] = [];
  let items: ReactNode[] = [];
  let kind: "ul" | "ol" | null = null;

  function flush() {
    if (items.length === 0) return;
    if (kind === "ol") out.push(<ol key={`l${out.length}`} className="md-list">{items}</ol>);
    else out.push(<ul key={`l${out.length}`} className="md-list">{items}</ul>);
    items = [];
    kind = null;
  }

  lines.forEach((ln, i) => {
    const h1 = ln.match(/^# (.+)$/);
    const h2 = ln.match(/^## (.+)$/);
    const h3 = ln.match(/^### (.+)$/);
    const ul = ln.match(/^\s*[-*] (.+)$/);
    const ol = ln.match(/^\s*\d+\. (.+)$/);
    const hr = /^\s*---+\s*$/.test(ln);
    const quote = ln.match(/^> (.+)$/);

    if (h1) { flush(); out.push(<h1 key={i}>{renderInline(h1[1])}</h1>); return; }
    if (h2) { flush(); out.push(<h2 key={i}>{renderInline(h2[1])}</h2>); return; }
    if (h3) { flush(); out.push(<h3 key={i}>{renderInline(h3[1])}</h3>); return; }
    if (hr) { flush(); out.push(<hr key={i} className="md-hr" />); return; }
    if (quote) { flush(); out.push(<blockquote key={i}>{renderInline(quote[1])}</blockquote>); return; }
    if (ul) {
      if (kind !== "ul") flush();
      kind = "ul";
      items.push(<li key={i}>{renderInline(ul[1])}</li>);
      return;
    }
    if (ol) {
      if (kind !== "ol") flush();
      kind = "ol";
      items.push(<li key={i}>{renderInline(ol[1])}</li>);
      return;
    }
    flush();
    if (ln.trim()) out.push(<p key={i}>{renderInline(ln)}</p>);
  });
  flush();
  return <>{out}</>;
}

export function Markdown({ src }: { src: string }) {
  // Extract fenced code blocks first (they preserve whitespace, no inline parsing)
  // Allow unclosed fences while streaming.
  const blocks: Array<{ type: "code" | "text"; lang?: string; content: string }> = [];
  const codeRe = /```([A-Za-z0-9_+-]*)\n?([\s\S]*?)(?:```|$)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(src)) !== null) {
    if (m.index > lastIdx) blocks.push({ type: "text", content: src.slice(lastIdx, m.index) });
    blocks.push({ type: "code", lang: m[1] || "", content: m[2] });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < src.length) blocks.push({ type: "text", content: src.slice(lastIdx) });

  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.type === "code") {
          return (
            <pre key={i} className="md-code">
              {b.lang && <span className="md-code-lang">{b.lang}</span>}
              <code>{b.content}</code>
            </pre>
          );
        }
        return <MdText key={i} src={b.content} />;
      })}
    </div>
  );
}
