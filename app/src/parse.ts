// Parse a .hand text file into a HandScript. Errors carry line numbers.
import type {
  Annotation, Call, Card, Deal, HandScript, HandType, LeadPlan, PlanningPause, Rank,
  ScriptedCall, ScriptedCard, Seat, Strain, Suit, Trick, Vulnerability,
} from './model';

export interface Issue { line?: number; msg: string }
export interface ParseResult { script?: HandScript; errors: Issue[] }

const SEATS: Seat[] = ['N', 'E', 'S', 'W'];
const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
const RANKS = 'AKQJT98765432';
const SYM: Record<string, Suit> = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C', '♡': 'H', '♢': 'D', '♤': 'S', '♧': 'C' };

export function parseCard(tok: string): Card | null {
  let t = tok.trim().toUpperCase().replace('10', 'T');
  for (const [k, v] of Object.entries(SYM)) t = t.split(k).join(v);
  let m = /^([SHDC])([AKQJT2-9])$/.exec(t) || /^([AKQJT2-9])([SHDC])$/.exec(t);
  if (!m) return null;
  const [a, b] = [m[1], m[2]];
  return SUITS.includes(a as Suit) ? { suit: a as Suit, rank: b as Rank } : { suit: b as Suit, rank: a as Rank };
}

export function parseCall(tok: string): Call | null {
  const t = tok.trim().toUpperCase().replace('♠', 'S').replace('♥', 'H').replace('♦', 'D').replace('♣', 'C');
  if (t === 'P' || t === 'PASS') return { kind: 'pass' };
  if (t === 'X' || t === 'DBL' || t === 'DOUBLE') return { kind: 'double' };
  if (t === 'XX' || t === 'RDBL' || t === 'REDOUBLE') return { kind: 'redouble' };
  const m = /^([1-7])(S|H|D|C|NT|N)$/.exec(t);
  if (!m) return null;
  return { kind: 'bid', level: Number(m[1]) as 1, strain: (m[2] === 'N' ? 'NT' : m[2]) as Strain };
}

interface Line { n: number; indent: number; text: string }

export function parseHand(src: string): ParseResult {
  const errors: Issue[] = [];
  const err = (line: number | undefined, msg: string) => errors.push({ line, msg });
  const lines: Line[] = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    // strip comments: '#' at line start, or ' #' after content
    let s = raw.replace(/\t/g, '    ');
    if (/^\s*#/.test(s)) return;
    s = s.replace(/\s+#.*$/, '');
    if (!s.trim()) return;
    lines.push({ n: i + 1, indent: s.length - s.trimStart().length, text: s.trim() });
  });

  const head: Record<string, string> = {};
  const sections: Record<string, Line[]> = {};
  const sectionLine: Record<string, number> = {};
  let cur: string | null = null;
  for (const l of lines) {
    const sec = /^([a-z ]+):\s*$/i.exec(l.text);
    if (l.indent === 0 && sec) { cur = sec[1].toLowerCase(); sections[cur] = []; sectionLine[cur] = l.n; continue; }
    const kv = /^([a-z ]+):\s*(.+)$/i.exec(l.text);
    if (l.indent === 0 && kv) { head[kv[1].toLowerCase()] = kv[2].trim(); cur = null; continue; }
    if (cur) sections[cur].push(l); else err(l.n, `Not sure where this line belongs: "${l.text}"`);
  }

  const need = (k: string) => { if (!head[k]) err(undefined, `Missing header line "${k}:"`); return head[k] ?? ''; };
  const seat = (k: string, dflt?: Seat): Seat => {
    const v = (head[k] ?? dflt ?? '').toUpperCase()[0] as Seat;
    if (!SEATS.includes(v)) { err(undefined, `"${k}:" must be N, E, S or W`); return 'S'; }
    return v;
  };
  const type = need('type').toLowerCase() as HandType;
  if (type && !['exercise', 'example', 'counting'].includes(type)) err(undefined, `type must be exercise, example or counting`);
  const vul = (head['vulnerable'] ?? 'none').toLowerCase().replace('-', '');
  const vulMap: Record<string, Vulnerability> = { none: 'none', ns: 'NS', ew: 'EW', both: 'both', all: 'both' };
  // Duplicate board numbering: dealer rotates N E S W; vulnerability runs ONEB NEBO EBON BONE over 16 boards.
  const board = head['board'] ? Number(head['board']) : 0;
  if (head['board'] && !(board >= 1 && Number.isInteger(board))) err(undefined, '"board:" must be a whole number, 1 or more');
  if (board && head['dealer'] && head['dealer'].toUpperCase()[0] !== boardDealer(board)) err(undefined, `Board ${board} has ${boardDealer(board)} as dealer, but "dealer:" says ${head['dealer']}`);
  if (board && head['vulnerable'] && vulMap[vul] !== boardVul(board)) err(undefined, `Board ${board} is vulnerable ${boardVul(board)}, but "vulnerable:" says ${head['vulnerable']}`);

  // ---- deal
  const deal = {} as Deal;
  for (const l of sections['deal'] ?? []) {
    const parts = l.text.split(/\s+/);
    const s = parts[0].toUpperCase() as Seat;
    if (!SEATS.includes(s)) { err(l.n, `Deal line should start with N, E, S or W`); continue; }
    const suits = parts.slice(1);
    if (suits.length !== 4) { err(l.n, `${s} needs four suit groups (♠ ♥ ♦ ♣, "-" for a void), found ${suits.length}`); continue; }
    const hand: Card[] = [];
    suits.forEach((g, i) => {
      if (g === '-' || g === '—') return;
      for (const ch of g.toUpperCase().replace(/10/g, 'T').replace(/[♠♥♦♣]/g, '')) {
        if (!RANKS.includes(ch)) err(l.n, `"${ch}" is not a card rank`);
        else hand.push({ suit: SUITS[i], rank: ch as Rank });
      }
    });
    deal[s] = hand;
  }
  if (!sections['deal']) err(undefined, 'Missing "deal:" section');

  // ---- annotations (shared by calls and cards)
  function applyAnno(target: Annotation & { countMark?: 'loser' | 'winner' }, l: Line): boolean {
    const t = l.text;
    let m;
    if ((m = /^key:\s*(.*)$/i.exec(t))) { target.key = m[1]; return true; }
    if ((m = /^(?:not|why not)\s+(\S+):\s*(.*)$/i.exec(t))) { (target.whyNot ??= {})[m[1]] = m[2]; return true; }
    if ((m = /^meaning:\s*(.*)$/i.exec(t))) { target.meaning = m[1]; return true; }
    if (/^pause$/i.test(t)) { target.pause = true; return true; }
    if ((m = /^count:\s*(loser|winner)$/i.exec(t))) { target.countMark = m[1].toLowerCase() as 'loser'; return true; }
    return false;
  }

  // ---- auction
  const auction: ScriptedCall[] = [];
  let lastAnnoField: { obj: any; key: string; sub?: string } | null = null;
  for (const l of sections['auction'] ?? []) {
    const m = /^([NESW])\s+(\S+?)(\*)?(?:\s*=\s*(.*))?$/i.exec(l.text);
    if (m && parseCall(m[2])) {
      const c: ScriptedCall = { seat: m[1].toUpperCase() as Seat, call: parseCall(m[2])!, studentDecides: !!m[3] };
      if (m[4]) c.meaning = m[4];
      auction.push(c); lastAnnoField = m[4] ? { obj: c, key: 'meaning' } : null;
      continue;
    }
    const last = auction[auction.length - 1];
    if (last && applyAnno(last, l)) { lastAnnoField = annoField(last, l.text); continue; }
    if (lastAnnoField) { appendTo(lastAnnoField, l.text); continue; }
    err(l.n, `Can't read auction line "${l.text}" (expected e.g. "N 1NT = meaning")`);
  }

  // ---- play
  const play: Trick[] = [];
  let lastTrick: Trick | null = null;
  lastAnnoField = null;
  for (const l of sections['play'] ?? []) {
    const tm = /^(\d+)[.:]?\s+(.*)$/.exec(l.text);
    if (tm) {
      const toks = tm[2].split(/\s+/);
      const cards: ScriptedCard[] = [];
      let ok = true;
      for (let i = 0; i < toks.length; i++) {
        const s = toks[i].replace(/:$/, '').toUpperCase();
        if (SEATS.includes(s as Seat) && i + 1 < toks.length) {
          let ct = toks[++i]; const star = ct.endsWith('*'); if (star) ct = ct.slice(0, -1);
          const card = parseCard(ct);
          if (!card) { err(l.n, `"${ct}" is not a card`); ok = false; continue; }
          cards.push({ seat: s as Seat, card, studentDecides: star });
        } else { err(l.n, `Expected a seat then a card, e.g. "W SQ"; got "${toks[i]}"`); ok = false; break; }
      }
      lastTrick = { number: Number(tm[1]), cards };
      if (ok || cards.length) play.push(lastTrick);
      lastAnnoField = null;
      continue;
    }
    if (!lastTrick) { err(l.n, `Play line before any trick: "${l.text}"`); continue; }
    let m;
    if ((m = /^ok:\s*(.*)$/i.exec(l.text))) {
      const map: Record<string, Suit> = { S: 'S', H: 'H', D: 'D', C: 'C', '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' };
      lastTrick.okLeads = m[1].split(/[\s,]+/).filter(Boolean).map(x => map[x.toUpperCase()]).filter(Boolean);
      continue;
    }
    if ((m = /^note:\s*(.*)$/i.exec(l.text))) { lastTrick.note = m[1]; lastAnnoField = { obj: lastTrick, key: 'note' }; continue; }
    if (/^pause$/i.test(l.text)) { const c = lastTrick.cards[lastTrick.cards.length - 1]; if (c) c.pause = true; continue; }
    // card-level: "SK key: ..." / "SK not SA: ..." / "SK count: loser"
    if ((m = /^(\S+)\s+(.*)$/.exec(l.text)) && parseCard(m[1])) {
      const pc = parseCard(m[1])!;
      const card = lastTrick.cards.find(c => c.card.suit === pc.suit && c.card.rank === pc.rank);
      if (!card) { err(l.n, `${m[1]} is not played in trick ${lastTrick.number}`); continue; }
      if (applyAnno(card, { ...l, text: m[2] })) { lastAnnoField = annoField(card, m[2]); continue; }
    }
    if (lastAnnoField) { appendTo(lastAnnoField, l.text); continue; }
    err(l.n, `Can't read play line "${l.text}"`);
  }

  // ---- planning
  let planning: PlanningPause | undefined;
  if (sections['planning']) {
    planning = { reminders: [] };
    for (const l of sections['planning']) {
      const m = /^([a-z ]+):\s*(.*)$/i.exec(l.text);
      if (!m) { err(l.n, `Can't read planning line "${l.text}"`); continue; }
      const k = m[1].toLowerCase().trim(), v = m[2].trim();
      if (k === 'remind') { planning.reminders.push(v); continue; }
      // "7", "7-9", or for a suit "0-1 = Ruff the third heart in dummy."
      const cm = /^(\d+)(?:\s*-\s*(\d+))?\s*(?:=\s*(.*))?$/.exec(v);
      if (!cm) { err(l.n, `"${k}" needs a number or a range like 7-9`); continue; }
      const cnt = { min: Number(cm[1]), max: Number(cm[2] ?? cm[1]) }, txt = cm[3]?.trim();
      if (cnt.max < cnt.min) err(l.n, `"${k}": range ${v} runs backwards`);
      if (k === 'trumps out') planning.trumpsOutstanding = cnt.min;
      else if (k === 'losers') planning.losers = cnt;
      else if (k === 'winners') planning.winners = cnt;
      else if (['spades', 'hearts', 'diamonds', 'clubs'].includes(k)) {
        const su = k[0].toUpperCase() as Suit;
        (planning.bySuit ??= {})[su] = cnt;
        if (txt) (planning.suitNotes ??= {})[su] = txt;
      }
      else { err(l.n, `Unknown planning item "${k}"`); continue; }
      if (txt && !['spades', 'hearts', 'diamonds', 'clubs'].includes(k)) err(l.n, `Only a suit line takes "= note"`);
    }
  }

  // ---- lead planning (defensive hands): "declarer: 15-17 = East's 1NT showed 15-17."
  let leadPlan: LeadPlan | undefined;
  if (sections['lead planning']) {
    leadPlan = { why: {}, reminders: [] };
    for (const l of sections['lead planning']) {
      const m = /^([a-z ]+):\s*(.*)$/i.exec(l.text);
      if (!m) { err(l.n, `Can't read lead planning line "${l.text}"`); continue; }
      const k = m[1].toLowerCase().trim(), v = m[2].trim();
      if (k === 'remind') { leadPlan.reminders.push(v); continue; }
      if (!['declarer', 'dummy', 'partner'].includes(k)) { err(l.n, `Unknown lead planning item "${k}" (declarer, dummy, partner or remind)`); continue; }
      const cm = /^(\d+)(?:\s*-\s*(\d+))?\s*(?:=\s*(.*))?$/.exec(v);
      if (!cm) { err(l.n, `"${k}" needs points or a range like 15-17`); continue; }
      const key = k as 'declarer' | 'dummy' | 'partner';
      leadPlan[key] = { min: Number(cm[1]), max: Number(cm[2] ?? cm[1]) };
      if (cm[3]) leadPlan.why[key] = cm[3].trim();
    }
  }

  const block = (k: string) => sections[k]?.map(l => l.text).join(' ');
  const script: HandScript = {
    id: need('id'), title: head['title'] ?? head['id'] ?? 'Untitled', type,
    lesson: Number(head['lesson'] ?? 0),
    concepts: (head['concepts'] ?? '').split(',').map(s => s.trim()).filter(Boolean),
    student: seat('student', 'S'), dealer: head['dealer'] || !board ? seat('dealer') : boardDealer(board),
    vulnerable: head['vulnerable'] || !board ? vulMap[vul] ?? (err(undefined, 'vulnerable must be none, NS, EW or both'), 'none') : boardVul(board),
    board: board || undefined,
    deal, auction, auctionRecap: block('auction recap'), planning, leadPlan, play, playRecap: block('play recap'),
  };
  for (const k of Object.keys(sections))
    if (!['deal', 'auction', 'auction recap', 'planning', 'lead planning', 'play', 'play recap'].includes(k))
      err(sectionLine[k], `Unknown section "${k}:"`);
  return { script, errors };
}

function annoField(obj: any, text: string) {
  const m = /^(key|meaning):/i.exec(text);
  if (m) return { obj, key: m[1].toLowerCase() };
  const w = /^(?:not|why not)\s+(\S+):/i.exec(text);
  if (w) return { obj, key: 'whyNot', sub: w[1] };
  return null;
}
function appendTo(f: { obj: any; key: string; sub?: string }, text: string) {
  if (f.sub) f.obj[f.key][f.sub] += ' ' + text; else f.obj[f.key] = (f.obj[f.key] ?? '') + ' ' + text;
}

export const boardDealer = (b: number): Seat => (['N', 'E', 'S', 'W'] as Seat[])[(b - 1) % 4];
export function boardVul(b: number): Vulnerability {
  const cycle = 'OnebNeboEbonBone'.toLowerCase(); // o = none, n = NS, e = EW, b = both
  return ({ o: 'none', n: 'NS', e: 'EW', b: 'both' } as Record<string, Vulnerability>)[cycle[(b - 1) % 16]];
}
