'use strict';

/**
 * Stage 11 — a small, SAFE Markdown renderer for agent messages.
 *
 * No dependencies and no raw HTML passthrough: the source is escaped
 * first, then a deliberately small Markdown subset is rendered —
 * headings, paragraphs, bold/italic/strike, inline code, fenced code
 * blocks (with language label), lists, blockquotes, horizontal rules,
 * tables, and http(s)/mailto links. Anything else stays plain text.
 * Works in the browser (window.MuseMarkdown) and in Node tests.
 */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderInline(text) {
  // Inline code first: park the spans so emphasis rules never touch them.
  const spans = [];
  let t = String(text).replace(/`([^`\n]+)`/g, (_m, code) => {
    spans.push('<code>' + code + '</code>');
    return '\u0000' + (spans.length - 1) + '\u0000';
  });
  // Links: [label](https://…) — only safe schemes become anchors;
  // anything else degrades to its label (whole match consumed).
  t = t.replace(/\[([^\]\n]+)\]\(([^)]*)\)/g, (m, label, url) => {
    const u = url.trim();
    if (/^(https?:\/\/|mailto:)/i.test(u) && !/\s/.test(u)) {
      return '<a href="' + u + '" data-external="1">' + label + '</a>';
    }
    return label;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => spans[Number(i)] || '');
  return t;
}

function renderMarkdown(src) {
  const escaped = escapeHtml(String(src == null ? '' : src));
  const lines = escaped.split('\n');
  const out = [];
  let i = 0;

  const isBlank = (l) => /^\s*$/.test(l);

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1; // closing fence (or EOF)
      const lang = fence[1] || '';
      out.push('<div class="codeblock"><div class="codeblock-head"><span>'
        + (lang || 'code') + '</span><button class="copy-btn" type="button">Salin</button></div>'
        + '<pre><code>' + buf.join('\n') + '</code></pre></div>');
      continue;
    }

    if (isBlank(line)) { i += 1; continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      i += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr />'); i += 1; continue; }

    // Table: header row + separator row.
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const splitRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      let html = '<table><thead><tr>' + head.map((c) => '<th>' + renderInline(c) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of rows) {
        html += '<tr>' + head.map((_, ci) => '<td>' + renderInline(r[ci] || '') + '</td>').join('') + '</tr>';
      }
      out.push(html + '</tbody></table>');
      continue;
    }

    // Blockquote (consecutive > lines).
    if (/^\s*&gt;\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i += 1;
      }
      out.push('<blockquote>' + buf.map((b) => renderInline(b)).join('<br />') + '</blockquote>');
      continue;
    }

    // Lists: consecutive - / * / + or 1. items (flat, checkbox aware).
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        items.push(m[3]);
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      const lis = items.map((item) => {
        const task = item.match(/^\[( |x|X)\]\s+(.*)$/);
        if (task && !ordered) {
          const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
          return '<li class="task"><input type="checkbox" disabled' + checked + ' /> ' + renderInline(task[2]) + '</li>';
        }
        return '<li>' + renderInline(item) + '</li>';
      }).join('');
      out.push('<' + tag + '>' + lis + '</' + tag + '>');
      continue;
    }

    // Paragraph: gather until a blank line or a block starter.
    const buf = [line];
    i += 1;
    while (i < lines.length && !isBlank(lines[i])
      && !/^```/.test(lines[i])
      && !/^#{1,4}\s/.test(lines[i])
      && !/^\s*&gt;\s?/.test(lines[i])
      && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push('<p>' + buf.map((b) => renderInline(b)).join('<br />') + '</p>');
  }

  return out.join('\n');
}

const api = { renderMarkdown, renderInline, escapeHtml };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.MuseMarkdown = api;
