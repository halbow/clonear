// Tiny, dependency-free helpers for ticket files.
// - parseFrontmatter: split a raw .md file into its frontmatter fields and body
// - updateTicketText: rewrite some fields + the body, keeping every other line as-is
// - renderMarkdown: a minimal, safe markdown -> HTML renderer for ticket bodies
//
// Frontmatter is the YAML subset build.py understands: scalars, inline lists
// (`key: [a, b]`) and block lists (`key:` followed by `  - item` lines).
// renderMarkdown covers headings, bold/italic, inline code, fenced code blocks,
// links, unordered and ordered lists, and paragraphs. All text is HTML-escaped
// first, so its output is safe to inject with innerHTML.

// Returns { data, body, fmLines } where fmLines is null when there is no
// frontmatter block (or it is never closed).
export function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        const fmLines = lines.slice(1, i);
        const body = lines.slice(i + 1).join("\n").replace(/^\n+|\n+$/g, "");
        return { data: parseFields(fmLines), body, fmLines };
      }
    }
  }
  return { data: {}, body: text, fmLines: null };
}

export function stripFrontmatter(text) {
  return parseFrontmatter(text).body;
}

function parseFields(lines) {
  const data = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    i++;
    if (!line || line.startsWith("#") || !line.includes(":")) continue;
    const idx = line.indexOf(":");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (value === "") {
      // Possibly a block list on the following `- item` lines.
      const items = [];
      while (i < lines.length && lines[i].trim().startsWith("- ")) {
        items.push(scalar(lines[i].trim().slice(2).trim()));
        i++;
      }
      data[key] = items;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      data[key] = inner ? inner.split(",").map((v) => scalar(v.trim())) : [];
    } else {
      data[key] = scalar(value);
    }
  }
  return data;
}

function scalar(value) {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function formatValue(value) {
  if (Array.isArray(value)) return `[${value.map((v) => formatScalar(v)).join(", ")}]`;
  return formatScalar(value);
}

function formatScalar(value) {
  const str = String(value).replace(/\s*\r?\n\s*/g, " ");
  // Quote anything the parser would otherwise read as a list, comment or quote.
  if (/^[\[#"'-]|^\s|\s$/.test(str)) {
    return str.includes('"') ? `'${str}'` : `"${str}"`;
  }
  return str;
}

// Rewrite `fields` (a { key: value } map) and the body of a ticket file.
// Keys that already exist are replaced in place; new keys are appended; a key
// whose value is "" or null is removed. Every other frontmatter line (unknown
// keys, comments) is preserved verbatim.
export function updateTicketText(raw, fields, body) {
  const fmLines = [...(parseFrontmatter(raw).fmLines || [])];

  for (const [key, value] of Object.entries(fields)) {
    const start = fmLines.findIndex((l) => {
      const t = l.trim();
      return t.includes(":") && !t.startsWith("- ") && t.slice(0, t.indexOf(":")).trim() === key;
    });
    const remove = value === null || value === undefined || value === "";
    const line = `${key}: ${formatValue(value)}`;

    if (start === -1) {
      if (!remove) fmLines.push(line);
      continue;
    }
    // A key with an empty inline value may own the block-list lines below it.
    let end = start + 1;
    if (fmLines[start].trim().endsWith(":")) {
      while (end < fmLines.length && fmLines[end].trim().startsWith("- ")) end++;
    }
    fmLines.splice(start, end - start, ...(remove ? [] : [line]));
  }

  const text = ["---", ...fmLines, "---"].join("\n");
  const trimmed = (body || "").replace(/^\n+|\s+$/g, "");
  return trimmed ? `${text}\n\n${trimmed}\n` : `${text}\n`;
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
