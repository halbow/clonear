// Tiny, dependency-free helpers for the ticket viewer.
// - stripFrontmatter: drop the leading --- ... --- block from a raw .md file
// - renderMarkdown: a minimal, safe markdown -> HTML renderer for ticket bodies
//
// This is intentionally small: it covers headings, bold/italic, inline code,
// fenced code blocks, links, unordered and ordered lists, and paragraphs.
// All text is HTML-escaped first, so it is safe to inject with innerHTML.

export function stripFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== undefined && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
      }
    }
  }
  return text;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderInline(text) {
  // Order matters: escape first, then apply inline patterns on the escaped text.
  let out = escapeHtml(text);
  // inline code `code`
  out = out.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // links [label](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const safe = /^https?:\/\/|^\/|^\.\.?\//.test(url) ? url : "#";
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  // bold **text**
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  // italic *text* (avoid matching ** already consumed)
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return out;
}

export function renderMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const html = [];
  let i = 0;
  let listType = null; // "ul" | "ol" | null

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block
    if (/^```/.test(line.trim())) {
      closeList();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        buf.push(escapeHtml(lines[i]));
        i++;
      }
      i++; // consume closing fence
      html.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }

    // headings
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      if (listType !== "ul") {
        closeList();
        html.push("<ul>");
        listType = "ul";
      }
      html.push(`<li>${renderInline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      i++;
      continue;
    }

    // ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      if (listType !== "ol") {
        closeList();
        html.push("<ol>");
        listType = "ol";
      }
      html.push(`<li>${renderInline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
      i++;
      continue;
    }

    // blank line
    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    // paragraph (accumulate consecutive non-blank, non-special lines)
    closeList();
    const para = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6})\s|^\s*[-*]\s|^\s*\d+\.\s|^```/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    html.push(`<p>${renderInline(para.join(" "))}</p>`);
  }

  closeList();
  return html.join("\n");
}
