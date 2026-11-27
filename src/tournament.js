'use strict';

/**
 * Stage 5b — candidate tournament panel support.
 *
 * The workflow this encodes is the one that wins judged make.fun text
 * bounties: generate MANY candidates for one brief, then pick by
 * structure and the user's rating — never by first impression. This
 * module is the pure core: it builds the generation prompt, parses the
 * model's answer back into candidates (JSON array, numbered list, or
 * --- separated), ranks rated candidates, and persists tournaments as
 * JSON under <workspace>/.tournament/ with the winner exported to
 * <workspace>/TOURNAMENT-WINNER.md.
 *
 * The model call itself lives in main.js (it needs the active
 * provider/key); everything testable lives here.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIN_CANDIDATES = 3;
const MAX_CANDIDATES = 20;

function clampCount(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return 8;
  return Math.min(MAX_CANDIDATES, Math.max(MIN_CANDIDATES, v));
}

function buildCandidatePrompt({ brief, criteria, count }) {
  const n = clampCount(count);
  const lines = [
    'Kamu mengikuti kontes teks yang dinilai juri. Hasilkan TEPAT ' + n + ' kandidat yang BENAR-BENAR BERBEDA satu sama lain (sudut, struktur, dan gaya bervariasi), untuk brief berikut:',
    '',
    'BRIEF:',
    String(brief || '').trim(),
  ];
  if (criteria && String(criteria).trim()) {
    lines.push('', 'KRITERIA PENILAIAN JURI (patuhi satu per satu):', String(criteria).trim());
  }
  lines.push(
    '',
    'ATURAN OUTPUT — WAJIB:',
    '- Balas HANYA dengan JSON array of strings, tanpa teks lain, tanpa code fence.',
    '- Setiap elemen = satu kandidat lengkap, siap pakai apa adanya.',
    '- Jangan memberi nomor, label, atau penjelasan di dalam kandidat.'
  );
  return lines.join('\n');
}

/**
 * Parse a model answer into candidate strings. Tolerates, in order:
 * a JSON array of strings, a ```json fenced array, lines separated by
 * a line containing only ---, and a numbered list (1. / 1) / - ).
 * Returns at most `max` non-empty candidates.
 */
function parseCandidates(text, max) {
  const limit = clampCount(max || MAX_CANDIDATES);
  const raw = String(text || '').trim();
  if (!raw) return [];

  const tryJson = (s) => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    } catch (_) { /* fall through */ }
    return null;
  };

  let out = tryJson(raw);
  if (!out) {
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) out = tryJson(fence[1].trim());
  }
  if (!out) {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start >= 0 && end > start) out = tryJson(raw.slice(start, end + 1));
  }
  if (!out) {
    if (/^\s*---\s*$/m.test(raw)) {
      out = raw.split(/^\s*---\s*$/m).map((x) => x.trim()).filter(Boolean);
    }
  }
  if (!out) {
    const lines = raw.split('\n');
    const items = [];
    let current = null;
    for (const line of lines) {
      const m = line.match(/^\s*(?:\d{1,2}[.)]|[-*•])\s+(.*)$/);
      if (m) {
        if (current !== null) items.push(current);
        current = m[1];
      } else if (current !== null) {
        current += '\n' + line;
      }
    }
    if (current !== null) items.push(current);
    out = items.map((x) => x.trim()).filter(Boolean);
    if (out.length < 2) out = null;
  }
  if (!out) {
    // Last resort: the whole answer is one candidate.
    out = [raw];
  }
  return out.slice(0, limit);
}

function newCandidate(text) {
  return {
    id: 'c-' + crypto.randomBytes(3).toString('hex'),
    text: String(text || ''),
    rating: 0,        // 0 = unrated, 1..5 = user stars
    eliminated: false,
    winner: false,
  };
}

function createTournament({ brief, criteria, texts }) {
  return {
    id: 'tournament-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex'),
    createdAt: new Date().toISOString(),
    brief: String(brief || ''),
    criteria: String(criteria || ''),
    candidates: (texts || []).map(newCandidate),
  };
}

/**
 * Rank candidates for display: winner first, then rated (stars desc,
 * shorter text first on ties — judged copy rewards density), then
 * unrated in original order, eliminated last.
 */
function rankCandidates(candidates) {
  const list = (candidates || []).map((c, i) => ({ ...c, _i: i }));
  const score = (c) => {
    if (c.winner) return 4000;
    if (c.eliminated) return -1000;
    if (c.rating > 0) return 1000 + c.rating * 10;
    return 0;
  };
  list.sort((a, b) => {
    const d = score(b) - score(a);
    if (d !== 0) return d;
    if (a.rating > 0 && b.rating > 0 && a.text.length !== b.text.length) {
      return a.text.length - b.text.length;
    }
    return a._i - b._i;
  });
  return list.map(({ _i, ...c }) => c);
}

/** The current winner candidate, or null. */
function winnerOf(tournament) {
  if (!tournament || !Array.isArray(tournament.candidates)) return null;
  return tournament.candidates.find((c) => c.winner) || null;
}

function tournamentStats(tournament) {
  const cs = (tournament && tournament.candidates) || [];
  return {
    total: cs.length,
    rated: cs.filter((c) => c.rating > 0).length,
    eliminated: cs.filter((c) => c.eliminated).length,
    hasWinner: cs.some((c) => c.winner),
    bestRating: cs.reduce((m, c) => Math.max(m, c.rating || 0), 0),
  };
}

/* --------------------------- persistence ----------------------------- */

function tournamentDir(workspace) {
  return path.join(workspace, '.tournament');
}

function saveTournament(workspace, tournament) {
  const dir = tournamentDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, tournament.id + '.json');
  fs.writeFileSync(file, JSON.stringify(tournament, null, 2) + '\n', 'utf8');
  const winner = winnerOf(tournament);
  if (winner) {
    const md = [
      '# Pemenang Turnamen Kandidat',
      '',
      '**Brief:** ' + tournament.brief,
      tournament.criteria ? '**Kriteria:** ' + tournament.criteria : '',
      '**Dipilih:** ' + new Date().toISOString(),
      '',
      '---',
      '',
      winner.text,
      '',
    ].filter((l) => l !== null && l !== undefined).join('\n');
    fs.writeFileSync(path.join(workspace, 'TOURNAMENT-WINNER.md'), md, 'utf8');
  }
  return file;
}

function loadTournament(workspace, id) {
  const file = path.join(tournamentDir(workspace), id + '.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listTournaments(workspace) {
  const dir = tournamentDir(workspace);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      out.push({
        id: t.id, createdAt: t.createdAt, brief: t.brief,
        stats: tournamentStats(t),
        winnerText: winnerOf(t) ? winnerOf(t).text.slice(0, 120) : '',
      });
    } catch (_) { /* skip torn file */ }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

module.exports = {
  MIN_CANDIDATES, MAX_CANDIDATES,
  clampCount,
  buildCandidatePrompt,
  parseCandidates,
  newCandidate,
  createTournament,
  rankCandidates,
  winnerOf,
  tournamentStats,
  saveTournament,
  loadTournament,
  listTournaments,
};
