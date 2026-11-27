'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, escapeHtml } = require('../renderer/markdown');

test('escapes raw HTML — no script or tag injection from model output', () => {
  const out = renderMarkdown('halo <script>alert(1)</script> <b>mentah</b>');
  assert.ok(!out.includes('<script>'));
  assert.ok(!out.includes('<b>mentah</b>'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.equal(escapeHtml('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

test('renders headings, emphasis, inline code and paragraphs', () => {
  const out = renderMarkdown('# Judul\n\nHalo **tebal**, *miring*, ~~coret~~, dan `kode **bukan tebal**`.');
  assert.ok(out.includes('<h1>Judul</h1>'));
  assert.ok(out.includes('<strong>tebal</strong>'));
  assert.ok(out.includes('<em>miring</em>'));
  assert.ok(out.includes('<del>coret</del>'));
  assert.ok(out.includes('<code>kode **bukan tebal**</code>'), 'code span content is never re-processed');
});

test('fenced code blocks carry language + copy button and escaped code', () => {
  const out = renderMarkdown('```js\nconst a = 1 < 2;\n```');
  assert.ok(out.includes('class="codeblock"'));
  assert.ok(out.includes('<span>js</span>'));
  assert.ok(out.includes('copy-btn'));
  assert.ok(out.includes('const a = 1 &lt; 2;'));
});

test('lists, task lists, blockquotes, hr and tables', () => {
  const out = renderMarkdown('- satu\n- [x] selesai\n- [ ] belum\n\n> kutip\n\n---\n\n| A | B |\n|---|---|\n| 1 | 2 |');
  assert.ok(out.includes('<li>satu</li>'));
  assert.ok(out.includes('type="checkbox" disabled checked'));
  assert.ok(out.includes('type="checkbox" disabled />'));
  assert.ok(out.includes('<blockquote>kutip</blockquote>'));
  assert.ok(out.includes('<hr />'));
  assert.ok(out.includes('<th>A</th>') && out.includes('<td>2</td>'));
  const ol = renderMarkdown('1. pertama\n2. kedua');
  assert.ok(ol.includes('<ol><li>pertama</li><li>kedua</li></ol>'));
});

test('links: only http(s)/mailto become anchors', () => {
  const out = renderMarkdown('[aman](https://example.com/x) [email](mailto:a@b.c) [jahat](javascript:alert(1)) [rel](/path)');
  assert.ok(out.includes('<a href="https://example.com/x" data-external="1">aman</a>'));
  assert.ok(out.includes('<a href="mailto:a@b.c" data-external="1">email</a>'));
  assert.ok(!out.includes('javascript:'));
  assert.ok(out.includes('jahat') && out.includes('rel'), 'unsafe links degrade to their label');
  assert.ok(!out.includes('alert(1))'), 'no dangling paren from a consumed unsafe link');
});
