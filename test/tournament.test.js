'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  clampCount, buildCandidatePrompt, parseCandidates, createTournament,
  rankCandidates, winnerOf, tournamentStats,
  saveTournament, loadTournament, listTournaments,
} = require('../src/tournament');

test('clampCount keeps generation between 3 and 20, default 8', () => {
  assert.equal(clampCount(1), 3);
  assert.equal(clampCount(99), 20);
  assert.equal(clampCount('bukan angka'), 8);
  assert.equal(clampCount(12), 12);
});

test('buildCandidatePrompt carries brief, criteria and the JSON-only rule', () => {
  const p = buildCandidatePrompt({ brief: 'Tagline untuk kedai kopi', criteria: 'Lucu, maks 6 kata', count: 5 });
  assert.match(p, /TEPAT 5 kandidat/);
  assert.match(p, /Tagline untuk kedai kopi/);
  assert.match(p, /Lucu, maks 6 kata/);
  assert.match(p, /JSON array of strings/);
});

test('parseCandidates: JSON array, fenced JSON, numbered list, --- split', () => {
  assert.deepEqual(parseCandidates('["satu","dua","tiga"]', 20), ['satu', 'dua', 'tiga']);
  assert.deepEqual(parseCandidates('Berikut hasilnya:\n```json\n["a","b"]\n```', 20), ['a', 'b']);
  assert.deepEqual(parseCandidates('1. Alpha\n2. Beta\n3. Gamma', 20), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(parseCandidates('Alpha\n---\nBeta\n---\nGamma', 20), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(parseCandidates('hanya satu jawaban utuh', 20), ['hanya satu jawaban utuh']);
  assert.deepEqual(parseCandidates('', 20), []);
  assert.equal(parseCandidates('["1","2","3","4","5"]', 3).length, 3, 'max respected');
});

test('rankCandidates: winner > rated (shorter wins ties) > unrated > eliminated', () => {
  const t = createTournament({
    brief: 'b', criteria: '',
    texts: ['belum dinilai', 'bintang lima yang agak panjang sekali', 'bintang lima', 'dibuang', 'pemenang'],
  });
  t.candidates[1].rating = 5;
  t.candidates[2].rating = 5;
  t.candidates[3].eliminated = true;
  t.candidates[4].winner = true;
  const ranked = rankCandidates(t.candidates);
  assert.equal(ranked[0].text, 'pemenang');
  assert.equal(ranked[1].text, 'bintang lima', 'tie on stars → shorter first');
  assert.equal(ranked[2].text, 'bintang lima yang agak panjang sekali');
  assert.equal(ranked[3].text, 'belum dinilai');
  assert.equal(ranked[4].text, 'dibuang');
  assert.equal(winnerOf(t).text, 'pemenang');
  const stats = tournamentStats(t);
  assert.deepEqual(stats, { total: 5, rated: 2, eliminated: 1, hasWinner: true, bestRating: 5 });
});

test('save/load/list round-trips and exports the winner file', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-tournament-'));
  const t = createTournament({ brief: 'Slogan', criteria: 'Singkat', texts: ['satu', 'dua'] });
  t.candidates[1].winner = true;
  t.candidates[1].rating = 5;
  saveTournament(ws, t);

  const back = loadTournament(ws, t.id);
  assert.equal(back.brief, 'Slogan');
  assert.equal(winnerOf(back).text, 'dua');

  const winnerFile = fs.readFileSync(path.join(ws, 'TOURNAMENT-WINNER.md'), 'utf8');
  assert.match(winnerFile, /Slogan/);
  assert.match(winnerFile, /\ndua\n/);

  const list = listTournaments(ws);
  assert.equal(list.length, 1);
  assert.equal(list[0].winnerText, 'dua');
  assert.equal(loadTournament(ws, 'tidak-ada'), null);
});
