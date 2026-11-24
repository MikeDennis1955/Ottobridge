// Reviewer table: load a hand script, step through auction and play, leave notes.
import type { Call, Card, Count, HandScript, PlanningPause, Seat, Suit } from './model';
import { parseHand, type Issue } from './parse';
import { validate, next, partner, side, callText, cardKey, fmt, hcp, SUITS, SUIT_SYM, RANKS, trickWinner, type Derived } from './rules';

declare const BUNDLED_HANDS: { file: string; text: string }[];
declare const claude: any;
import { scoreHand } from './score';
import { Recorder, type Recording } from './recorder';
import { LESSONS, CATALOG, type Block, type Concept, type Lesson } from './lessons';

// ---------- state ----------
type Step =
  | { kind: 'deal' }
  | { kind: 'call'; i: number }
  | { kind: 'auctionRecap' }
  | { kind: 'card'; t: number; c: number }
  | { kind: 'planning' }
  | { kind: 'playRecap' };

interface Loaded {
  file: string; text: string; original: string; edited: boolean;
  script?: HandScript; parseErrors: Issue[];
  errors: Issue[]; warnings: Issue[]; derived?: Derived; steps: Step[];
}
interface Note { id: string; handId: string; step: string; stepLabel: string; flag: string; text: string; at: string }

const S = {
  hands: [] as Loaded[],
  cur: 0,
  step: 0,
  showPlayed: false,
  showAll: false,
  mode: (lsGet('bridge-mode') === 'review' ? 'review' : 'student') as 'student' | 'review',
  help: lsGet('bridge-help') !== 'off',
  picks: new Map<number, string>(),
  auto: new Set<number>(),               // steps the student let Autoplay or Claim play for them      // step index -> what the student chose
  plan: { vals: {} as Record<string, string>, checked: false },
  tab: 'auction' as 'auction' | 'tricks' | 'checks' | 'script' | 'notes',
  notes: new Map<string, Note>(),
  db: null as any,
  playing: 0 as any,
  view: 'home' as 'home' | 'lesson' | 'hand' | 'wrap',   // student mode screens
  fresh: false,   // reviewer preview: show the home page as a first-time visitor sees it
  lesson: 5,
  concept: '' as string,                  // concept the student came from
};

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const suitSpan = (su: Suit) => `<span class="sym ${su === 'H' || su === 'D' ? 'red' : 'blk'}">${SUIT_SYM[su]}</span>`;
// Turn "4H", "♠Q", "3NT" inside prose into colored symbols
const prose = (s = '') => esc(s).replace(/[♠♥♦♣]/g, m => suitSpan(({ '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' } as any)[m]));
const SEAT_NAME: Record<Seat, string> = { N: 'North', E: 'East', S: 'South', W: 'West' };

function callHTML(c: Call, cls = '') {
  if (c.kind === 'pass') return `<span class="bc pass ${cls}">Pass</span>`;
  if (c.kind === 'double') return `<span class="bc dbl ${cls}">X</span>`;
  if (c.kind === 'redouble') return `<span class="bc rdbl ${cls}">XX</span>`;
  return `<span class="bc bid ${cls}">${c.level}${c.strain === 'NT' ? '<span class="nt">NT</span>' : suitSpan(c.strain)}</span>`;
}
const cardText = (c: Card) => `${suitSpan(c.suit)}${c.rank}`;

// ---------- loading ----------
function load(file: string, text: string, original = text): Loaded {
  const r = parseHand(text);
  const L: Loaded = { file, text, original, edited: text !== original, script: r.script, parseErrors: r.errors, errors: [], warnings: [], steps: [] };
  if (r.script) {
    const v = validate(r.script);
    L.errors = v.errors; L.warnings = v.warnings; L.derived = v.derived;
    L.steps = buildSteps(r.script, v.derived);
  }
  return L;
}

function buildSteps(s: HandScript, d: Derived): Step[] {
  const st: Step[] = [{ kind: 'deal' }];
  s.auction.forEach((_, i) => st.push({ kind: 'call', i }));
  if (s.auctionRecap) st.push({ kind: 'auctionRecap' });
  s.play.forEach((t, ti) => t.cards.forEach((_, ci) => {
    st.push({ kind: 'card', t: ti, c: ci });
    if (ti === 0 && ci === 0 && s.planning && d.contract) st.push({ kind: 'planning' });
  }));
  if (s.playRecap) st.push({ kind: 'playRecap' });
  return st;
}

const stepId = (st: Step) =>
  st.kind === 'call' ? `call-${st.i + 1}` : st.kind === 'card' ? `trick-${st.t + 1}-${st.c + 1}` : st.kind;

function stepLabel(L: Loaded, st: Step): string {
  const s = L.script!;
  if (st.kind === 'deal') return 'The deal';
  if (st.kind === 'call') { const a = s.auction[st.i]; return `Call ${st.i + 1}: ${SEAT_NAME[a.seat]} ${callText(a.call)}`; }
  if (st.kind === 'card') { const pc = s.play[st.t].cards[st.c]; return `Trick ${st.t + 1}, card ${st.c + 1}: ${SEAT_NAME[pc.seat]} ${fmt(pc.card)}`; }
  return { auctionRecap: 'Auction recap', planning: 'Planning pause', playRecap: 'Play recap' }[st.kind];
}

// ---------- notes storage (shared db when available, else this browser) ----------
const LS_KEY = 'bridge-review-notes';
function lsGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

// Push any recording saved only in this browser (a failed shared save) up to shared storage.
async function syncRecordings(db: any) {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('rec:')) keys.push(k); }
    if (!keys.length) return;
    const shared = new Map<string, any>();
    for (const d of (await db.collection('recordings').get()).docs) shared.set(d.id, d.data());
    for (const k of keys) {
      const r = JSON.parse(lsGet(k) || 'null'); if (!r?.handId || !r.tricks?.length) continue;
      const s = shared.get(r.handId);
      if (!s || (r.at && s.at && r.at > s.at)) { try { await db.collection('recordings').doc(r.handId).set(r); } catch { /* try next time */ } }
    }
  } catch { /* storage unavailable */ }
}

async function initStorage() {
  try { for (const n of JSON.parse(lsGet(LS_KEY) || '[]') as Note[]) S.notes.set(n.id, n); } catch { /* ignore */ }
  try {
    const db = await claude?.use?.('db');
    if (!db) { setStore('Notes saved in this browser only'); return; }
    S.db = db;
    setStore('Notes are saved for Claude to read');
    syncRecordings(db);
    db.collection('notes').onSnapshot((snap: any) => {
      for (const d of snap.docs) { const n = d.data(); if (n) S.notes.set(d.id, { ...n, id: d.id }); }
      for (const ch of snap.docChanges()) if (ch.type === 'removed') S.notes.delete(ch.doc.id);
      render();
    }, () => setStore('Could not reach shared notes; saving in this browser'));
    const drafts = await db.collection('scripts').get();
    for (const d of drafts.docs) {
      const data = d.data(); if (!data?.text) continue;
      const i = S.hands.findIndex(h => h.script?.id === d.id || h.file === data.file);
      if (i >= 0 && S.hands[i].text !== data.text) S.hands[i] = load(S.hands[i].file, data.text, S.hands[i].original);
    }
    render();
  } catch { setStore('Notes saved in this browser only'); }
}
function setStore(msg: string) { const el = $('#store'); if (el) el.textContent = msg; }

async function saveNote(n: Note | null, id: string) {
  if (n) S.notes.set(id, n); else S.notes.delete(id);
  lsSet(LS_KEY, JSON.stringify([...S.notes.values()]));
  if (S.db) {
    try { n ? await S.db.collection('notes').doc(id).set({ handId: n.handId, step: n.step, stepLabel: n.stepLabel, flag: n.flag, text: n.text, at: n.at }) : await S.db.collection('notes').doc(id).delete(); }
    catch { setStore('Could not save to shared notes; kept in this browser'); }
  }
}
async function saveDraft(L: Loaded) {
  if (!S.db || !L.script) return false;
  try {
    if (L.text === L.original) await S.db.collection('scripts').doc(L.script.id).delete();
    else await S.db.collection('scripts').doc(L.script.id).set({ file: L.file, text: L.text, at: new Date().toISOString() });
    return true;
  } catch { return false; }
}

// ---------- derived position at a step ----------
interface Pos {
  callsShown: number;          // number of calls visible
  played: Set<string>;         // cards gone from hands
  trick: { t: number; upto: number } | null; // trick shown in the centre
  tricksNS: number; tricksEW: number;
  final?: boolean; // play recap: table cleared, all four original hands shown
  cleared?: number; // trick just gathered up (0-based); the centre is empty while the student leads to the next one
}
function position(L: Loaded, idx: number): Pos {
  const s = L.script!, st = L.steps[idx];
  const pos: Pos = { callsShown: 0, played: new Set(), trick: null, tricksNS: 0, tricksEW: 0 };
  if (st.kind === 'deal') return pos;
  if (st.kind === 'call') { pos.callsShown = st.i + 1; return pos; }
  pos.callsShown = s.auction.length;
  let T = -1, C = -1;
  if (st.kind === 'card') { T = st.t; C = st.c; }
  else if (st.kind === 'planning') { T = 0; C = 0; }
  else if (st.kind === 'playRecap') { T = s.play.length - 1; C = 3; }
  for (let t = 0; t <= T; t++) {
    const tr = s.play[t]; if (!tr) break;
    const upto = t < T ? tr.cards.length - 1 : C;
    for (let c = 0; c <= upto && c < tr.cards.length; c++) pos.played.add(cardKey(tr.cards[c].card));
    if (upto >= 3 && tr.cards.length === 4) {
      const w = L.derived!.winners[t]; if (w) side(w) === 'NS' ? pos.tricksNS++ : pos.tricksEW++;
    }
  }
  if (T >= 0) pos.trick = { t: T, upto: C };
  if (st.kind === 'playRecap') { pos.trick = null; pos.played = new Set(); pos.final = true; } // hand over: clear the table, show the whole deal
  return pos;
}

// ---------- render ----------
function render() {
  const L = S.hands[S.cur];
  document.body.classList.toggle('student', S.mode === 'student');
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === S.mode));
  const hb = $<HTMLInputElement>('#help'); if (hb) hb.checked = S.help;
  renderPicker();
  const page = S.mode === 'student' && S.view !== 'hand';
  $('#lessonview').hidden = !page; ($('main') as HTMLElement).hidden = page;
  renderSetbar();
  if (!(S.mode === 'student' && S.view === 'hand')) closeNotes();
  if (page) { S.view === 'home' ? renderHome() : S.view === 'wrap' ? renderWrap() : renderLesson(); return; }
  if (!L) return;
  const s = L.script;
  const fatal = !s || L.parseErrors.length > 0 && !L.steps.length;
  $('#title').innerHTML = s ? `${prose(s.title)}` : esc(L.file);
  $('#meta').innerHTML = s ? [
    `<span class="chip type-${s.type}">${{ exercise: 'Exercise', example: 'Example', counting: 'Counting hand' }[s.type] ?? s.type}</span>`,
    `Lesson ${s.lesson}`, s.concepts.length && S.mode === 'review' ? `Concepts ${esc(s.concepts.join(', '))}` : '',
    s.board ? `Board ${s.board}` : '', `Dealer ${SEAT_NAME[s.dealer]}`, `Vul ${s.vulnerable === 'none' ? 'none' : s.vulnerable}`,
    `Student ${SEAT_NAME[s.student]}`, L.edited && S.mode === 'review' ? '<span class="chip edited">Edited</span>' : '',
  ].filter(Boolean).join('<span class="dot">·</span>') : '';
  renderChecksBadge(L);
  if (fatal || !L.steps.length) { $('#table').innerHTML = `<div class="empty">This script can't be shown yet. Open the Script tab to fix it.</div>`; $('#stepcard').innerHTML = ''; renderTabs(L); return; }
  S.step = Math.max(0, Math.min(S.step, L.steps.length - 1));
  const pend = pendingAt(L, S.step);
  const pos = shownPosition(L, pend);
  renderTable(L, pos);
  renderControls(L);
  if (S.mode === 'student') renderStudentCard(L, pos); else renderStepCard(L, pos);
  renderTabs(L);
}

const VUL_TEXT: Record<string, string> = { none: 'neither side is vulnerable', NS: 'North-South are vulnerable', EW: 'East-West are vulnerable', both: 'both sides are vulnerable' };

/** The hand's score in one short phrase, e.g. "N/S +450". */
function scoreShort(L: Loaded): string {
  const s = L.script!, d = L.derived!, sc = scoreHand(d.contract!, s.vulnerable, d.declarerTricks);
  return `${sc.side[0]}/${sc.side[1]} +${sc.points}`;
}
function scoreHTML(L: Loaded): string {
  const s = L.script!, d = L.derived!, c = d.contract!;
  const sc = scoreHand(c, s.vulnerable, d.declarerTricks);
  const odd = d.declarerTricks - 6, per = c.strain === 'C' || c.strain === 'D' ? 20 : 30;
  const bonus = sc.lines.slice(1).filter(l => !/overtrick/.test(l.label)).map(l => `${l.pts} ${l.label.replace(/ \(.*\)$/, '').toLowerCase()}`);
  let how: string;
  if (sc.made && !c.doubled) how = [c.strain === 'NT' ? `40 + ${odd - 1} × 30 for tricks` : `${odd} × ${per} for tricks`, ...bonus].join(' + ');
  else if (!sc.made && !c.doubled) how = `down ${c.level + 6 - d.declarerTricks} × ${s.vulnerable === 'both' || s.vulnerable === (sc.side === 'NS' ? 'EW' : 'NS') ? 100 : 50}`;
  else how = sc.lines.map(l => `${l.pts} ${l.label.toLowerCase()}`).join(' + ');
  return `<p class="scoreline"><b>${sc.side} +${sc.points}</b> <span class="muted">(${esc(how)})</span></p>`;
}

// --- Record play (Reviewer mode): Mike plays the hand; threads read it from the 'recordings' collection ---
async function openRecorder() {
  const L = S.hands[S.cur], s = L?.script, c = L?.derived?.contract;
  if (!s || !c) return;
  const el = $('#recorder');
  let prev: Recording | null = null;
  try { if (S.db) { const all = await S.db.collection('recordings').get(); const d = all.docs.find((x: any) => x.id === s.id); prev = d ? d.data() : null; } } catch { /* none yet */ }
  if (!prev) { try { prev = JSON.parse(lsGet('rec:' + s.id) || 'null'); } catch { prev = null; } }
  const rec = new Recorder(s, c.strain, c.declarer, `${c.level}${c.strain === 'NT' ? 'NT' : SUIT_SYM[c.strain]}${c.doubled}`, el, async r => {
    lsSet('rec:' + s.id, JSON.stringify(r));
    if (!S.db) return 'Saved in this browser only (shared storage unavailable). Use Copy in the Script tab instead.';
    try { await S.db.collection('recordings').doc(s.id).set(r); return `Saved at ${new Date().toLocaleTimeString()}. Tell Claude in the project that ${s.id} has a recorded line.`; }
    catch { return 'Could not save to shared storage; saved in this browser only.'; }
  }, () => { el.hidden = true; document.body.classList.remove('recording'); });
  rec.load(prev);
  el.hidden = false; document.body.classList.add('recording');
  rec.render();
}
// ---------- lessons (student mode) ----------
const lessonOf = (L: Loaded) => L.script?.lesson ?? 0;
function handsFor(lesson: number, concept?: string) {
  return S.hands.map((h, i) => ({ h, i })).filter(({ h }) => h.script && h.script.lesson === lesson && (!concept || h.script.concepts.includes(concept)));
}
function progGet(id: string): { right: number; total: number } | null { try { return JSON.parse(lsGet('prog:' + id) || 'null'); } catch { return null; } }
function progSet(id: string, v: { right: number; total: number }) { lsSet('prog:' + id, JSON.stringify(v)); }
const bidSyms = (t: string) => prose(t).replace(/\b([1-7])([CDHS])\b/g, (_, n, su) => n + suitSpan(su)).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
function blocksHTML(bs: Block[]) {
  return bs.map(b => typeof b === 'string' ? `<p>${bidSyms(b)}</p>` : 'list' in b ? `<ul>${b.list.map(x => `<li>${bidSyms(x)}</li>`).join('')}</ul>` : 'aside' in b ? `<aside class="laside"><div class="lasidet">${esc(b.aside)}</div>${b.text.map(x => `<p>${bidSyms(x)}</p>`).join('')}</aside>` : 'ol' in b ? `<ol>${b.ol.map(x => `<li>${bidSyms(x)}</li>`).join('')}</ol>` : 'sub' in b ? `<h4>${esc(b.sub)}</h4>` : 'note' in b ? `<aside class="lnote">${bidSyms(b.note)}</aside>` : 'pre' in b ? `<pre class="lpre">${bidSyms(b.pre)}</pre>` : 'auction' in b ? ((a: string[]) => `<table class="lauc"><tr><th>West</th><th>North</th><th>East</th><th>South</th></tr>${Array.from({ length: Math.ceil(a.length / 4) }, (_, r) => `<tr>${[0, 1, 2, 3].map(c => `<td>${a[r * 4 + c] ? bidSyms(a[r * 4 + c]) : ''}</td>`).join('')}</tr>`).join('')}</table>`)(['', ...b.auction]) : `<h3>${esc(b.h)}</h3>`).join('');
}
function conceptOf(lesson: number, id: string): Concept | undefined { return LESSONS.find(l => l.n === lesson)?.concepts.find(c => c.id === id); }
// --- progress and resume (browser storage only) ---
const setOf = (lesson: number) => handsFor(lesson).sort((a, b) => a.h.script!.id.localeCompare(b.h.script!.id, 'en', { numeric: true }));
function lessonDone(n: number) { const set = setOf(n); return { done: set.filter(x => progGet(x.h.script!.id)).length, total: set.length }; }
function resumeGet(): { lesson: number; id: string } | null { try { return JSON.parse(lsGet('resume') || 'null'); } catch { return null; } }
function furthest(): number { return Number(lsGet('furthest') || 0); }
function markOpened(n: number) { if (n > furthest()) lsSet('furthest', String(n)); }
const lessonMeta = (n: number) => CATALOG.find(c => c.n === n);
const lessonReady = (n: number) => !!LESSONS.find(l => l.n === n) && setOf(n).length > 0;

function renderHome() {
  const el = $('#lessonview');
  const r = S.fresh ? null : resumeGet();
  const ri = r ? S.hands.findIndex(h => h.script?.id === r.id) : -1;
  const parts: string[] = ['<div class="lpage">'];
  if (ri >= 0) {
    const set = setOf(r!.lesson), pos = set.findIndex(x => x.i === ri);
    parts.push(`<button class="continue" id="cont"><span class="lbl">Continue</span><b>Lesson ${r!.lesson}, hand ${pos + 1} of ${set.length}</b><span>${prose(S.hands[ri].script!.title)}</span></button>`);
  } else {
    parts.push(`<div class="welcome"><h1>Welcome</h1><p>Each lesson has a short reading and a set of hands to bid and play. Start with Lesson 1, or jump to any lesson you like.</p><p><b>About the practice hands.</b> Every hand in Ottobridge is scripted. You choose your own bids and plays, and dummy's plays when you are declarer. If your choice matches the script, fine. If it does the same job, such as a touching card, the script's card is played without comment. If our analysis says it would go wrong, we explain why and show the script's choice.</p><p>New here? We recommend the <b>Orientation Tour</b> first: a one-minute look at the table and the menu.</p><button class="btn primary" id="welcometour">Take the Orientation Tour</button></div>`);
  }
  parts.push('<h2 class="homeh">Your lessons</h2><div class="lessonlist">');
  for (const c of CATALOG) {
    const ready = lessonReady(c.n), pr = ready ? (S.fresh ? { done: 0, total: setOf(c.n).length } : lessonDone(c.n)) : null;
    const start = ri < 0 && c.n === 1;
    parts.push(`<button class="lrow${ready ? '' : ' soon'}" ${ready ? `data-lesson="${c.n}"` : 'disabled'}><span class="ln">${c.n}</span><span class="lt"><b>${esc(c.title)}</b>${c.summary ? `<span class="muted small">${esc(c.summary)}</span>` : ''}</span><span class="lp">${!ready ? 'Coming soon' : start ? '<span class="pdone">Start here</span>' : pr!.done ? `${pr!.done} of ${pr!.total} hands` : `${pr!.total} hands`}</span></button>`);
  }
  parts.push('</div></div>');
  el.innerHTML = parts.join('');
  el.querySelectorAll<HTMLButtonElement>('[data-lesson]').forEach(b => b.onclick = () => openLesson(Number(b.dataset.lesson)));
  const cb = document.getElementById('cont'); if (cb) cb.onclick = () => playHand(ri);
  const wt = document.getElementById('welcometour'); if (wt) wt.onclick = takeTour;
}

function renderLesson() {
  const el = $('#lessonview');
  const les = LESSONS.find(l => l.n === S.lesson) ?? { n: S.lesson, title: '', intro: [], concepts: [] } as Lesson;
  const set = setOf(les.n), pr = lessonDone(les.n);
  const nextUp = set.find(x => !progGet(x.h.script!.id)) ?? set[0];
  const practiceBtn = set.length ? `<button class="btn primary big" data-go="${nextUp.i}">${pr.done === 0 ? `Practice this lesson: ${set.length} hand${set.length > 1 ? 's' : ''}` : pr.done < pr.total ? `Continue: hand ${set.findIndex(x => x === nextUp) + 1} of ${set.length}` : 'Play the hands again'}</button>` : '';
  const parts: string[] = [`<h1>Lesson ${les.n}: ${esc(les.title)}</h1>`];
  if (les.date) parts.push(`<div class="muted small">${esc(les.date)}</div>`);
  const unread = (lessonMeta(les.n)?.builds ?? []).filter(n => !lsGet('opened:' + n));
  if (unread.length) parts.push(`<aside class="lnote">This lesson builds on ${unread.map(n => `<button class="linkbtn" data-lesson="${n}">Lesson ${n} (${esc(lessonMeta(n)?.title ?? '')})</button>`).join(' and ')}. You're welcome to carry on, or start there first.</aside>`);
  if (set.length && !les.concepts.some(c => c.practice)) parts.push(`<div class="lstart">${practiceBtn}<span class="muted small">${pr.done ? `${pr.done} of ${pr.total} played` : 'Read on first, or start now. The lesson text is always one tap away at the table.'}</span></div>`);
  if (les.intro.length) parts.push(les.introFold ? `<details class="lintro"><summary>${esc(les.introFold)}</summary>${blocksHTML(les.intro)}</details>` : `<div class="lprose">${blocksHTML(les.intro)}</div>`);
  if (les.body) parts.push(`<section class="lconcept">${blocksHTML(les.body)}</section>`);
  else for (const c of les.concepts) {
    // a topic with its own lead-in (Lesson 1's demonstrations) keeps its hand button in the text
    const own = c.practice ? handsFor(les.n, c.id) : [];
    parts.push(`<section class="lconcept" id="concept-${c.id.replace('.', '-')}"><div class="lchead"><h2${les.conceptsSub ? ' class="sub"' : ''}>${bidSyms(c.name)}</h2></div>${blocksHTML(c.text)}${own.length ? `<div class="lpractice">${blocksHTML(c.practice!)}<div class="lhands">${own.map(({ h, i }) => `<button class="lhand" data-go="${i}"><b>${prose(h.script!.title)}</b>${progGet(h.script!.id) ? '<span class="pdone">done</span>' : ''}</button>`).join('')}</div></div>` : ''}</section>`);
  }
  if (les.outro) parts.push(`<div class="lprose">${blocksHTML(les.outro)}</div>`);
  if (set.length && !les.concepts.some(c => c.practice)) parts.push(`<section class="lend">${les.practiceIntro ? blocksHTML(les.practiceIntro) : ''}${practiceBtn}</section>`);
  el.innerHTML = `<div class="lpage">${parts.join('')}</div>`;
  el.querySelectorAll<HTMLButtonElement>('[data-go]').forEach(b => b.onclick = () => playHand(Number(b.dataset.go)));
  el.querySelectorAll<HTMLButtonElement>('[data-lesson]').forEach(b => b.onclick = () => openLesson(Number(b.dataset.lesson)));
}

function renderWrap() {
  const el = $('#lessonview');
  const les = LESSONS.find(l => l.n === S.lesson)!;
  const set = setOf(S.lesson);
  const rows = les.concepts.map(c => {
    const hs = set.filter(x => x.h.script!.concepts.includes(c.id));
    const ps = hs.map(x => progGet(x.h.script!.id)).filter(Boolean) as { right: number; total: number }[];
    const right = ps.reduce((a, p) => a + p.right, 0), total = ps.reduce((a, p) => a + p.total, 0);
    return hs.length ? `<tr><td>${bidSyms(c.name)}</td><td>${ps.length} of ${hs.length} hands played${total ? ` · ${right} of ${total} choices right` : ''}</td></tr>` : '';
  }).join('');
  const retry = set.filter(x => { const p = progGet(x.h.script!.id); return p && p.total && p.right < p.total; });
  const nextL = CATALOG.find(c => c.n > S.lesson && lessonReady(c.n));
  el.innerHTML = `<div class="lpage"><h1>Lesson ${les.n} complete</h1><p>Here's how it went, topic by topic.</p><table class="wrapt">${rows}</table>`
    + (retry.length ? `<h3>Worth another try</h3><div class="lhands">${retry.map(x => `<button class="lhand" data-go="${x.i}"><b>${prose(x.h.script!.title)}</b><span class="pdone">${progGet(x.h.script!.id)!.right}/${progGet(x.h.script!.id)!.total}</span></button>`).join('')}</div>` : '')
    + `<div class="row wraprow">${nextL ? `<button class="btn primary" data-lesson="${nextL.n}">Next: Lesson ${nextL.n}, ${esc(nextL.title)}</button>` : ''}<button class="btn" id="tohome">Back to your lessons</button></div></div>`;
  el.querySelectorAll<HTMLButtonElement>('[data-go]').forEach(b => b.onclick = () => playHand(Number(b.dataset.go)));
  el.querySelectorAll<HTMLButtonElement>('[data-lesson]').forEach(b => b.onclick = () => openLesson(Number(b.dataset.lesson)));
  $('#tohome').onclick = goHome;
}

function goHome() { S.fresh = false; S.view = 'home'; render(); window.scrollTo(0, 0); }
function openLesson(n: number, concept = '') {
  S.fresh = false;
  S.view = 'lesson'; S.lesson = n; lsSet('opened:' + n, '1'); markOpened(n); render();
  if (concept) setTimeout(() => document.getElementById('concept-' + concept.replace('.', '-'))?.scrollIntoView({ block: 'start' }), 0);
  else window.scrollTo(0, 0);
}
function playHand(i: number) {
  const L = S.hands[i]; if (!L?.script) return;
  S.view = 'hand'; S.lesson = L.script.lesson; lsSet('opened:' + S.lesson, '1'); markOpened(S.lesson);
  lsSet('resume', JSON.stringify({ lesson: S.lesson, id: L.script.id }));
  selectHand(i); window.scrollTo(0, 0);
  if (!lsGet('toured')) setTimeout(startTour, 400);
}
function nextInSet(): number {
  const set = setOf(S.lesson), k = set.findIndex(x => x.i === S.cur);
  return k >= 0 && k < set.length - 1 ? set[k + 1].i : -1;
}

// --- the bar above the table: where you are in the lesson's set ---
function renderSetbar() {
  const bar = $('#setbar'); if (!bar) return;
  const on = S.mode === 'student' && S.view === 'hand';
  bar.hidden = !on; if (!on) return;
  const set = setOf(S.lesson), k = set.findIndex(x => x.i === S.cur);
  bar.innerHTML = `<span class="setpos">Lesson ${S.lesson} · Hand ${k + 1} of ${set.length}</span><span class="dots">${set.map((x, j) => `<button class="sdot${j === k ? ' cur' : ''}${progGet(x.h.script!.id) ? ' done' : ''}" data-go="${x.i}" aria-label="Hand ${j + 1}${progGet(x.h.script!.id) ? ', played' : ''}" title="${esc(x.h.script!.title)}"></button>`).join('')}</span><button class="btn ghost sm" id="notesbtn">Lesson notes</button>`;
  bar.querySelectorAll<HTMLButtonElement>('[data-go]').forEach(b => b.onclick = () => playHand(Number(b.dataset.go)));
  $('#notesbtn').onclick = () => openNotes();
}

// --- lesson notes drawer at the table ---
function openNotes() {
  const L = S.hands[S.cur]; if (!L?.script) return;
  const les = LESSONS.find(l => l.n === L.script!.lesson);
  const cs = L.script.concepts.map(id => conceptOf(L.script!.lesson, id)).filter(Boolean) as Concept[];
  const d = $('#notesdrawer');
  d.innerHTML = `<div class="ndhead"><b>Lesson ${L.script.lesson} notes</b><button class="btn ghost sm" id="ndclose" aria-label="Close">✕</button></div><div class="lpage">${cs.map(c => `<h3>${bidSyms(c.name)}</h3>${blocksHTML(c.text)}`).join('') || (les ? blocksHTML(les.intro) : '')}</div><button class="linkbtn" id="ndfull">Open the whole lesson</button>`;
  d.hidden = false; d.classList.add('open');
  $('#ndclose').onclick = closeNotes;
  $('#ndfull').onclick = () => { closeNotes(); openLesson(L.script!.lesson, cs[0]?.id); };
}
function closeNotes() { const d = document.getElementById('notesdrawer'); if (d) { d.hidden = true; d.classList.remove('open'); } }

// --- top bar: breadcrumbs and menu ---
function renderCrumbs() {
  const el = $('#crumbs'); if (!el) return;
  if (S.mode !== 'student') { el.innerHTML = ''; return; }
  const L = S.hands[S.cur];
  const bits = [`<button class="crumb" id="cr-home">Lessons</button>`];
  if (S.view !== 'home') bits.push(`<button class="crumb" id="cr-les">Lesson ${S.lesson}${S.view === 'lesson' ? `: ${esc(lessonMeta(S.lesson)?.title ?? '')}` : ''}</button>`);
  if (S.view === 'hand' && L?.script) bits.push(`<span class="crumb cur">${prose(L.script.title)}</span>`);
  if (S.view === 'wrap') bits.push(`<span class="crumb cur">Wrap-up</span>`);
  el.innerHTML = bits.join('<span class="navsep">›</span>');
  $('#cr-home').onclick = goHome;
  const cl = document.getElementById('cr-les'); if (cl) cl.onclick = () => openLesson(S.lesson);
}

// --- first-visit tour ---
const TOUR: { sel: string; text: string; menu?: boolean }[] = [
  { sel: '#table', text: "This is the table. Your hand is at the bottom. The other hands stay hidden until the play shows them." },
  { sel: '#stepcard', text: "This panel tells you what's happening. When it's your turn, it shows a bidding box, or asks you to tap a card." },
  { sel: '#next', text: "Press Next to move the hand along, one call or card at a time." },
  { sel: '#notesbtn', text: "Lesson notes opens the lesson text for this hand, without leaving the table." },
  { sel: '#ask', text: "Stuck? Ask Claude a question about the hand." },
  { sel: '#menubtn', text: "The menu, top right, has a few more options. Let's look." },
  { sel: '#m-home', menu: true, text: "Home takes you back to your list of lessons. The Continue button there brings you back to where you left off." },
  { sel: '#m-help', menu: true, text: "Help hints explain a call or card when you pick a different one, and pause after dummy comes down so you can plan. Turn them off when you want to fly solo." },
  { sel: '#m-tour', menu: true, text: "And the Orientation Tour, if you ever want it again. Enjoy the hands!" },
];
function takeTour() {
    $('#menu').hidden = true;
    if (S.view !== 'hand') { // the tour points at the table, so take the student to a hand first
      const r = resumeGet(), ri = r ? S.hands.findIndex(h => h.script?.id === r.id) : -1;
      const set = setOf(S.view === 'home' ? 1 : S.lesson);
      const i = ri >= 0 && S.view === 'home' ? ri : (set[0] ?? setOf(1)[0])?.i;
      if (i === undefined) return;
      lsSet('toured', '1'); playHand(i);
    }
    setTimeout(startTour, 400);
}
let tourStep = -1;
function startTour() { if (S.mode !== 'student' || S.view !== 'hand') return; tourStep = 0; showTour(); }
function endTour() { tourStep = -1; $('#menu').hidden = true; lsSet('toured', '1'); $('#tour').hidden = true; document.querySelectorAll('.tourhi').forEach(e => e.classList.remove('tourhi')); }
function showTour() {
  document.querySelectorAll('.tourhi').forEach(e => e.classList.remove('tourhi'));
  const st = TOUR[tourStep]; if (!st) { endTour(); return; }
  $('#menu').hidden = !st.menu;
  const tgt = document.querySelector<HTMLElement>(st.sel);
  if (!tgt || tgt.offsetParent === null) { tourStep++; showTour(); return; }
  tgt.classList.add('tourhi'); tgt.scrollIntoView({ block: 'nearest' });
  const t = $('#tour'); t.hidden = false;
  t.innerHTML = `<p>${st.text}</p><div class="row"><span class="muted small">${tourStep + 1} of ${TOUR.length}</span><button class="btn ghost sm" id="tskip">Skip</button><button class="btn primary sm" id="tnext">${tourStep === TOUR.length - 1 ? 'Done' : 'Next'}</button></div>`;
  const r = tgt.getBoundingClientRect(), tw = Math.min(320, window.innerWidth - 32);
  t.style.width = tw + 'px';
  const left = Math.max(16, Math.min(window.innerWidth - tw - 16, r.left + r.width / 2 - tw / 2));
  const below = r.bottom + 12 + 140 < window.innerHeight;
  t.style.left = left + 'px';
  t.style.top = (below ? r.bottom + 12 : Math.max(16, r.top - 12 - t.offsetHeight)) + 'px';
  if (st.menu) { // beside the open menu (or under it on a phone), never covering it
    const mr = $('#menu').getBoundingClientRect();
    if (mr.left - tw - 12 >= 16) { t.style.left = (mr.left - tw - 12) + 'px'; t.style.top = r.top + 'px'; }
    else t.style.top = (mr.bottom + 12) + 'px';
  }
  $('#tnext').onclick = () => { tourStep++; showTour(); };
  $('#tskip').onclick = endTour;
}

function renderPicker() {
  const sel = $<HTMLSelectElement>('#picker');
  const html = S.hands.map((h, i) => {
    const n = h.errors.length + h.parseErrors.length;
    return `<option value="${i}">${esc(h.script?.id ?? h.file)} · ${esc(h.script?.title.replace(/[♠♥♦♣]/g, m => m) ?? '')}${n ? ` (${n} problem${n > 1 ? 's' : ''})` : ''}</option>`;
  }).join('');
  if (sel.innerHTML !== html) sel.innerHTML = html;
  sel.value = String(S.cur);
  const list = $('#handlist');
  renderCrumbs();
  if (S.mode === 'student') { list.innerHTML = ''; return; }
  // compact: one row per lesson, short ids, full title on hover
  const groups = new Map<number, string[]>();
  S.hands.forEach((h, i) => {
    const n = h.errors.length + h.parseErrors.length, id = h.script?.id ?? h.file, les = h.script?.lesson ?? 0;
    const short = id.replace(/^L\d+-/, '');
    if (!groups.has(les)) groups.set(les, []);
    groups.get(les)!.push(`<button class="hbtn${i === S.cur ? ' on' : ''}${n ? ' bad' : ''}" data-hand="${i}" title="${esc(id)}: ${esc(h.script?.title ?? '')}"><b>${esc(short)}</b></button>`);
  });
  list.innerHTML = [...groups.entries()].sort((x, y) => x[0] - y[0]).map(([les, bs]) => `<div class="hgroup"><span class="hles">Lesson ${les}</span>${bs.join('')}</div>`).join('');
  list.querySelectorAll<HTMLButtonElement>('[data-hand]').forEach(b => b.onclick = () => { selectHand(Number(b.dataset.hand)); const t = document.getElementById('title'); if (t && t.getBoundingClientRect().top > window.innerHeight * 0.6) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
}

function renderChecksBadge(L: Loaded) {
  const nE = L.errors.length + L.parseErrors.length, nW = L.warnings.length;
  const b = $('#checks');
  b.className = 'checks review-only ' + (nE ? 'bad' : nW ? 'warn' : 'ok');
  b.innerHTML = nE ? `${nE} rule problem${nE > 1 ? 's' : ''}` : nW ? `Legal · ${nW} thing${nW > 1 ? 's' : ''} to look at` : 'Legal: deal, auction and all 13 tricks check out';
}

// What the table shows. While a student pick is pending we show the step before it; if the pick is a lead, the
// previous trick has been gathered up, so the centre is empty.
function shownPosition(L: Loaded, pend: boolean): Pos {
  const pos = position(L, pend && S.step > 0 ? S.step - 1 : S.step), st = L.steps[S.step];
  if (pend && st.kind === 'card' && st.c === 0 && st.t > 0) { pos.trick = null; pos.cleared = st.t - 1; }
  return pos;
}

function seatAt(student: Seat, posn: 'bottom' | 'left' | 'top' | 'right'): Seat {
  return next(student, { bottom: 0, left: 1, top: 2, right: 3 }[posn]);
}

function renderTable(L: Loaded, pos: Pos) {
  const s = L.script!, d = L.derived!;
  const c = d.contract;
  const dummy = c ? partner(c.declarer) : null;
  const hands = (['top', 'left', 'right', 'bottom'] as const).map(p => {
    const seat = seatAt(s.student, p);
    const h = s.deal[seat] ?? [];
    if (!isVisible(L, pos, seat)) {
      const left = h.filter(x => !pos.played.has(cardKey(x))).length;
      return `<div class="hand ${p} hidden${whoseTurn(L, pos) === seat ? ' turn' : ''}"><div class="hlabel"><b>${SEAT_NAME[seat]}</b></div><div class="backs">${'<span></span>'.repeat(Math.min(left, 13))}</div><div class="hlabel">${left} card${left === 1 ? '' : 's'}</div></div>`;
    }
    const playable = playableFor(L, seat, pos);
    const rows = SUITS.map(su => {
      const cs = h.filter(x => x.suit === su).sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));
      const inner = cs.map(x => {
        const gone = pos.played.has(cardKey(x));
        if (gone && !S.showPlayed) return '';
        const k = cardKey(x);
        if (!gone && playable && playable.has(k)) return `<button class="r play" data-play="${k}" aria-label="Play ${fmt(x)}">${x.rank}</button>`;
        return `<span class="r${gone ? ' gone' : ''}${playable && !gone ? ' dim' : ''}">${x.rank}</span>`;
      }).join('');
      return `<div class="srow">${suitSpan(su)}<span class="ranks">${inner || (cs.length && !S.showPlayed ? '' : '<span class="void">—</span>')}</span></div>`;
    }).join('');
    const role = c && pos.callsShown === s.auction.length ? (seat === c.declarer ? 'Declarer' : seat === dummy ? 'Dummy' : '') : '';
    const turn = whoseTurn(L, pos) === seat;
    return `<div class="hand ${p}${turn ? ' turn' : ''}"><div class="hlabel"><b>${SEAT_NAME[seat]}</b>${seat === s.student ? ' <span class="you">student</span>' : ''}${role ? ` <span class="role">${role}</span>` : ''}<span class="hcp">${hcp(h)} HCP</span></div>${rows}</div>`;
  }).join('');

  // centre: current trick or current call
  let centre = '';
  if (pos.trick) {
    const tr = s.play[pos.trick.t];
    const w = pos.trick.upto >= 3 ? tr.cards[trickWinner(tr.cards, c!.strain)]?.seat : null;
    centre = tr.cards.slice(0, pos.trick.upto + 1).map((pc, i) => {
      const p = (['bottom', 'left', 'top', 'right'] as const).find(q => seatAt(s.student, q) === pc.seat)!;
      const latest = i === pos.trick!.upto;
      return `<div class="pcard at-${p}${pc.seat === w ? ' win' : ''}${latest ? ' latest' : ''}${pc.card.suit === 'H' || pc.card.suit === 'D' ? ' red' : ''}"><span>${pc.card.rank}</span><span>${SUIT_SYM[pc.card.suit]}</span>${i === 0 ? '<i>led</i>' : ''}</div>`;
    }).join('') + `<div class="tno">Trick ${pos.trick.t + 1}</div>`;
  } else if (pos.cleared !== undefined) {
    centre = `<div class="tno">Trick ${pos.cleared + 2}</div>`;
  } else if (pos.final) {
    centre = `<div class="tno">All 13 tricks played</div>`;
  } else if (pos.callsShown) {
    const a = s.auction[pos.callsShown - 1];
    const p = (['bottom', 'left', 'top', 'right'] as const).find(q => seatAt(s.student, q) === a.seat)!;
    centre = `<div class="ccall at-${p}"${a.meaning ? ` data-tip="${esc(a.meaning)}" tabindex="0"` : ''}>${callHTML(a.call, 'big')}</div>`;
  }
  const contract = c && pos.callsShown === s.auction.length
    ? `<div class="contract"><b>${c.level}${c.strain === 'NT' ? 'NT' : SUIT_SYM[c.strain]}${c.doubled}</b> by ${SEAT_NAME[c.declarer]}<br><span>N–S ${pos.tricksNS} · E–W ${pos.tricksEW}</span>${pos.final ? `<br><b class="fscore">${scoreShort(L)}</b>` : ''}</div>` : '';
  const prompt = S.mode === 'student' && pendingAt(L, S.step) && L.steps[S.step].kind === 'card' ? `<div class="yourturn">Your play: tap a card</div>` : '';
  $('#table').innerHTML = `<div class="felt">${prompt}${hands}<div class="centre">${centre}</div>${contract}<div class="compass">${(['top', 'left', 'right', 'bottom'] as const).map(p => `<span class="c-${p}">${seatAt(s.student, p)}</span>`).join('')}</div></div>`;
  $('#table').querySelectorAll<HTMLButtonElement>('[data-play]').forEach(b => b.onclick = () => studentPick(b.dataset.play!));
}

// Student's view: own hand during the auction; dummy appears after the opening lead; all at the play recap.
function isVisible(L: Loaded, pos: Pos, seat: Seat): boolean {
  const s = L.script!, st = L.steps[S.step], c = L.derived?.contract;
  if (allVisible() || seat === s.student || st.kind === 'playRecap') return true;
  if (!c || (!pos.trick && pos.cleared === undefined)) return false;
  const dummy = partner(c.declarer);
  if (seat === dummy) return true;
  if (s.student === dummy && seat === c.declarer) return true; // student watching from dummy's seat
  return false;
}

function whoseTurn(L: Loaded, pos: Pos): Seat | null {
  const st = L.steps[S.step];
  if (st.kind === 'call') return L.script!.auction[st.i].seat;
  if (st.kind === 'card') return L.script!.play[st.t].cards[st.c].seat;
  return null;
}

function renderControls(L: Loaded) {
  const n = L.steps.length;
  const r = $<HTMLInputElement>('#scrub');
  r.max = String(n - 1); r.value = String(S.step);
  $('#where').textContent = `${stepLabel(L, L.steps[S.step])}  (${S.step + 1}/${n})`;
  $('#play').textContent = S.playing ? 'Pause' : 'Autoplay';
  // note markers on the scrubber
  const marks = L.steps.map((st, i) => {
    const note = S.notes.get(noteKey(L, st)); if (!note) return '';
    return `<span class="mk ${note.flag}" style="left:${(i / Math.max(1, n - 1)) * 100}%" title="${esc(stepLabel(L, st))}"></span>`;
  }).join('');
  $('#marks').innerHTML = marks;
}

const noteKey = (L: Loaded, st: Step) => `${L.script!.id}~${stepId(st)}`;

function renderStepCard(L: Loaded, pos: Pos) {
  $<HTMLButtonElement>('#next').disabled = false;
  const s = L.script!, st = L.steps[S.step];
  const parts: string[] = [];
  const whyNot = (w?: Record<string, string>, isCall = true) => w && Object.keys(w).length
    ? `<div class="whynot"><div class="lbl">If the student picks instead</div>${Object.entries(w).map(([k, v]) => {
      const tag = k === '*' ? 'Anything else' : isCall ? callTextHTML(k) : cardTextHTML(k);
      return `<div class="wn"><span class="wk">${tag}</span><span>${prose(v)}</span></div>`;
    }).join('')}</div>` : '';
  const flags = (a: { studentDecides?: boolean; pause?: boolean }) =>
    `${a.studentDecides ? '<span class="chip you">Student decides</span>' : ''}${a.pause ? '<span class="chip pause">Autoplay stops here</span>' : ''}`;

  if (st.kind === 'deal') {
    parts.push(`<p class="lead">The deal. Step forward to reveal the auction one call at a time. You see the student's hand; dummy appears after the opening lead. Tick Show all hands to check the whole deal.</p>`);
  } else if (st.kind === 'call') {
    const a = s.auction[st.i];
    parts.push(`<div class="headline">${SEAT_NAME[a.seat]} ${callHTML(a.call)} ${flags(a)}</div>`);
    if (a.meaning) parts.push(`<div class="meaning"><div class="lbl">Tap meaning</div>${prose(a.meaning)}</div>`);
    else if (a.call.kind !== 'pass') parts.push(`<div class="meaning missing">No tap meaning written for this call.</div>`);
    if (a.key) parts.push(`<div class="key"><div class="lbl">Key point</div>${prose(a.key)}</div>`);
    parts.push(whyNot(a.whyNot));
  } else if (st.kind === 'auctionRecap') {
    parts.push(`<div class="headline">Auction recap</div><p>${prose(s.auctionRecap)}</p>`);
  } else if (st.kind === 'planning') {
    const p = s.planning!, d = L.derived!;
    const q: string[] = [];
    p.reminders.forEach(r => q.push(`<li>${prose(r)} <span class="muted">reminder</span></li>`));
    if (p.trumpsOutstanding !== undefined || d.trumpsOutstanding !== undefined)
      q.push(`<li>How many trumps are outstanding? <b>${p.trumpsOutstanding ?? '(not set)'}</b>${d.trumpsOutstanding !== undefined ? ` <span class="muted">checked: ${d.trumpsOutstanding}</span>` : ''}</li>`);
    if (p.losers !== undefined) q.push(`<li>How many obvious losers? <b>${countText(p.losers)}</b></li>`);
    if (p.winners !== undefined) q.push(`<li>How many obvious winners? <b>${countText(p.winners)}</b></li>`);
    if (p.bySuit) q.push(`<li>By suit:${catalogueHTML(p)}</li>`);
    parts.push(`<div class="headline">Planning pause</div><p class="muted">Dummy is down. Before declarer plays, the student answers:</p><ul class="plan">${q.join('')}</ul>`);
  } else if (st.kind === 'card') {
    const tr = s.play[st.t], pc = tr.cards[st.c];
    parts.push(`<div class="headline">${SEAT_NAME[pc.seat]} ${st.c === 0 ? 'leads' : 'plays'} <span class="cardtxt">${cardText(pc.card)}</span> ${flags(pc)}${pc.countMark ? `<span class="chip">${pc.countMark}</span>` : ''}</div>`);
    if (pc.key) parts.push(`<div class="key"><div class="lbl">Key point</div>${prose(pc.key)}</div>`);
    parts.push(whyNot(pc.whyNot, false));
    if (st.c === 3) {
      const w = L.derived!.winners[st.t];
      parts.push(`<div class="trickdone">${w ? `${SEAT_NAME[w]} wins trick ${st.t + 1}.` : ''} ${tr.note ? `<div class="note"><div class="lbl">Trick note</div>${prose(tr.note)}</div>` : ''}</div>`);
    } else if (tr.note) parts.push(`<p class="muted small">Trick note appears after the fourth card.</p>`);
  } else if (st.kind === 'playRecap') {
    const d = L.derived!, c = d.contract!;
    parts.push(`<div class="headline">Play recap</div><p class="muted">Declarer's side took ${d.declarerTricks} of 13; needed ${c.level + 6}.</p><p>${prose(s.playRecap)}</p>${scoreHTML(L)}`);
  }

  // review note form
  const key = noteKey(L, st), note = S.notes.get(key);
  const f = note?.flag ?? '';
  parts.push(`<form id="noteform" class="noteform">
    <div class="lbl">Your review of this step</div>
    <div class="flags" role="radiogroup">
      ${[['ok', 'Looks right'], ['problem', 'Problem'], ['question', 'Question']].map(([v, t]) =>
        `<label class="flag ${v}"><input type="radio" name="flag" value="${v}" ${f === v ? 'checked' : ''}><span>${t}</span></label>`).join('')}
    </div>
    <textarea id="notetext" rows="2" placeholder="What's wrong or worth changing here? (optional)">${esc(note?.text ?? '')}</textarea>
    <div class="row"><button type="submit" class="btn primary">Save note</button>${note ? '<button type="button" id="delnote" class="btn ghost">Remove</button>' : ''}<span id="saved" class="muted small">${note ? 'Saved ' + new Date(note.at).toLocaleString() : ''}</span></div>
  </form>`);
  $('#stepcard').innerHTML = parts.join('');
  $('#noteform').onsubmit = async e => {
    e.preventDefault();
    const flag = ($<HTMLInputElement>('#noteform input[name=flag]:checked')?.value) || (S.notes.get(key)?.flag) || 'problem';
    const text = $<HTMLTextAreaElement>('#notetext').value.trim();
    await saveNote({ id: key, handId: s.id, step: stepId(st), stepLabel: stepLabel(L, st), flag, text, at: new Date().toISOString() }, key);
    render(); const sv = $('#saved'); if (sv) sv.textContent = 'Saved';
  };
  const del = $('#delnote'); if (del) del.onclick = async () => { await saveNote(null, key); render(); };
}

function callTextHTML(k: string) { const c = parseCallSafe(k); return c ? callHTML(c, 'sm') : esc(k); }
function cardTextHTML(k: string) { const c = parseCardSafe(k); return c ? `<span class="cardtxt">${cardText(c)}</span>` : esc(k); }
import { parseCall as parseCallSafe, parseCard as parseCardSafe } from './parse';

// ---------- tabs ----------
function renderTabs(L: Loaded) {
  if (S.mode === 'student' && S.tab !== 'auction') { S.tab = 'auction'; $('#tabbody').innerHTML = ''; }
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
  const nE = L.errors.length + L.parseErrors.length + L.warnings.length;
  $('#tabcount-checks').textContent = nE ? String(nE) : '';
  const nN = [...S.notes.values()].filter(n => n.handId === L.script?.id).length;
  $('#tabcount-notes').textContent = nN ? String(nN) : '';
  const body = $('#tabbody');
  if (S.tab === 'script') { renderScriptTab(L); return; }
  if (!L.script) { body.innerHTML = ''; return; }
  const s = L.script;
  if (S.tab === 'auction') {
    const cols: Seat[] = ['W', 'N', 'E', 'S'];
    const offset = cols.indexOf(s.dealer);
    const cells: string[] = Array(offset).fill('<td></td>');
    s.auction.forEach((a, i) => {
      const stepIdx = L.steps.findIndex(x => x.kind === 'call' && x.i === i);
      const on = L.steps[S.step]?.kind === 'call' && (L.steps[S.step] as any).i === i;
      const hidden = position(L, pendingAt(L, S.step) && S.step > 0 ? S.step - 1 : S.step).callsShown <= i;
      const has = S.notes.get(noteKey(L, { kind: 'call', i }));
      if (hidden && !allVisible()) { cells.push('<td></td>'); return; }
      cells.push(`<td><button class="callbtn${on ? ' on' : ''}${hidden ? ' later' : ''}" data-step="${stepIdx}"${a.meaning ? ` data-tip="${esc(a.meaning)}"` : ''}>${callHTML(a.call)}${a.studentDecides ? '<i class="star">★</i>' : ''}${a.key ? '<i class="kp">key</i>' : ''}${has ? `<i class="nm ${has.flag}"></i>` : ''}</button></td>`);
    });
    const rows: string[] = [];
    for (let i = 0; i < cells.length; i += 4) rows.push(`<tr>${cells.slice(i, i + 4).join('')}</tr>`);
    body.innerHTML = `<table class="auction"><thead><tr>${cols.map(c => `<th>${SEAT_NAME[c]}${c === s.student ? ' ★' : ''}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>
      ${S.mode === 'student' ? '<p class="muted small">Hover over or tap a call to see its meaning.</p>' : ''}<p class="muted small review-only">★ the student makes this call · <i class="kp">key</i> has a key point · tap a call to jump to it. Hover over or tap a call to see its meaning.</p>`;
  } else if (S.tab === 'tricks') {
    const d = L.derived!;
    body.innerHTML = `<div class="tscroll"><table class="tricks"><thead><tr><th>#</th><th>Lead</th><th>2nd</th><th>3rd</th><th>4th</th><th>Won</th></tr></thead><tbody>${
      s.play.map((t, ti) => !allVisible() && ti > (L.steps[S.step]?.kind === 'playRecap' ? 99 : position(L, S.step).trick?.t ?? -1) ? '' : `<tr class="${L.steps[S.step]?.kind === 'card' && (L.steps[S.step] as any).t === ti ? 'on' : ''}"><td>${t.number}</td>${t.cards.map((pc, ci) => {
        const idx = L.steps.findIndex(x => x.kind === 'card' && x.t === ti && x.c === ci);
        const has = S.notes.get(noteKey(L, { kind: 'card', t: ti, c: ci }));
        return `<td><button class="tc${d.winners[ti] === pc.seat ? ' win' : ''}" data-step="${idx}"><span class="seat">${pc.seat}</span>${cardText(pc.card)}${pc.studentDecides ? '<i class="star">★</i>' : ''}${has ? `<i class="nm ${has.flag}"></i>` : ''}</button></td>`;
      }).join('')}<td>${d.winners[ti] ?? ''}</td></tr>${t.note ? `<tr class="tnote"><td></td><td colspan="5">${prose(t.note)}</td></tr>` : ''}`).join('')
    }</tbody></table></div>`;
  } else if (S.tab === 'checks') {
    const list = (arr: Issue[], cls: string) => arr.map(i => `<li class="${cls}">${i.line ? `<span class="ln">line ${i.line}</span>` : ''}${prose(i.msg)}</li>`).join('');
    const all = list(L.parseErrors, 'bad') + list(L.errors, 'bad') + list(L.warnings, 'warn');
    const d = L.derived;
    body.innerHTML = `<ul class="issues">${all || '<li class="ok">Everything checks out.</li>'}</ul>
      <div class="checked"><div class="lbl">Checked automatically</div><ul>
      <li>52 different cards, 13 per hand</li><li>Auction: turn order, each bid higher than the last, doubles and redoubles allowed, ends with three passes</li>
      <li>Contract and declarer worked out from the auction${d?.contract ? `: <b>${d.contract.level}${d.contract.strain === 'NT' ? 'NT' : SUIT_SYM[d.contract.strain]}${d.contract.doubled}</b> by ${SEAT_NAME[d.contract.declarer]}` : ''}</li>
      <li>Opening lead from declarer's left; each trick led by the last winner</li><li>Every card is in that player's hand, played once, following suit when able</li>
      <li>All 13 tricks scripted; tricks won${d?.contract ? `: declarer's side ${d.declarerTricks}` : ''}</li><li>"Trumps out" in the planning pause matches the deal</li>
      <li>Trick counts quoted in the last note or play recap match the play</li></ul></div>`;
  } else if (S.tab === 'notes') {
    const mine = [...S.notes.values()].filter(n => n.handId === s.id).sort((a, b) => stepOrder(L, a.step) - stepOrder(L, b.step));
    body.innerHTML = mine.length ? `<ul class="notelist">${mine.map(n => `<li><button class="jump" data-step="${stepOrder(L, n.step)}"><span class="nm ${n.flag}"></span><b>${esc(n.stepLabel)}</b></button><div>${n.text ? prose(n.text) : `<span class="muted">${n.flag === 'ok' ? 'Looks right' : 'No comment'}</span>`}</div></li>`).join('')}</ul>
      <div class="row"><button class="btn" id="copynotes">Copy all notes</button><span class="muted small" id="copied"></span></div>`
      : `<p class="muted">No notes on this hand yet. At any step, choose Looks right, Problem or Question, add a comment if you like, and save.</p>`;
    const cp = $('#copynotes'); if (cp) cp.onclick = () => copyText(mine.map(n => `${s.id} · ${n.stepLabel} · ${n.flag.toUpperCase()}${n.text ? ': ' + n.text : ''}`).join('\n'), '#copied');
  }
  if (S.mode !== 'student') body.querySelectorAll<HTMLButtonElement>('[data-step]').forEach(b => b.onclick = () => { go(Number(b.dataset.step)); });
}
const stepOrder = (L: Loaded, id: string) => Math.max(0, L.steps.findIndex(st => stepId(st) === id));

function renderScriptTab(L: Loaded) {
  const body = $('#tabbody');
  if (!body.querySelector('#editor')) {
    body.innerHTML = `<p class="muted small">Edit the script and press Check and reload. Lines starting with # are comments. ${S.db ? 'Saved edits are kept for Claude to pick up.' : ''}</p>
      <textarea id="editor" spellcheck="false" rows="22"></textarea>
      <div class="row"><button class="btn primary" id="reload">Check and reload</button>
      <button class="btn" id="savedraft">Save edits</button>
      <button class="btn ghost" id="revert">Revert to original</button>
      <button class="btn ghost" id="copyscript">Copy text</button>
      <label class="btn ghost file">Open a .hand file<input type="file" id="openfile" accept=".hand,.txt,text/plain"></label>
      <span class="muted small" id="scriptmsg"></span></div>`;
    $<HTMLTextAreaElement>('#editor').value = L.text;
    $('#reload').onclick = () => { applyText($<HTMLTextAreaElement>('#editor').value); };
    $('#savedraft').onclick = async () => {
      applyText($<HTMLTextAreaElement>('#editor').value);
      const ok = await saveDraft(S.hands[S.cur]);
      $('#scriptmsg').textContent = ok ? 'Edits saved.' : 'Saved in this page only; copy the text to keep it.';
    };
    $('#revert').onclick = async () => { const H = S.hands[S.cur]; S.hands[S.cur] = load(H.file, H.original); await saveDraft(S.hands[S.cur]); $<HTMLTextAreaElement>('#editor').value = H.original; render(); $('#scriptmsg').textContent = 'Back to the original.'; };
    $('#copyscript').onclick = () => copyText($<HTMLTextAreaElement>('#editor').value, '#scriptmsg');
    $<HTMLInputElement>('#openfile').onchange = async ev => {
      const f = (ev.target as HTMLInputElement).files?.[0]; if (!f) return;
      const text = await f.text();
      S.hands.push(load(f.name, text)); S.cur = S.hands.length - 1; S.step = 0;
      body.innerHTML = ''; render();
    };
  }
  const n = L.parseErrors.length + L.errors.length;
  const msg = $('#scriptmsg'); if (msg && !msg.textContent) msg.textContent = n ? `${n} problem${n > 1 ? 's' : ''}; see Checks.` : '';
}
function applyText(text: string) {
  const H = S.hands[S.cur];
  S.hands[S.cur] = load(H.file, text, H.original);
  const L = S.hands[S.cur];
  const n = L.parseErrors.length + L.errors.length;
  render();
  $('#scriptmsg').textContent = n ? `${n} problem${n > 1 ? 's' : ''}; see the Checks tab.` : 'Reloaded. All rules check out.';
}

function copyText(t: string, msgSel: string) {
  const done = (m: string) => { const el = $(msgSel); if (el) el.textContent = m; };
  try { navigator.clipboard.writeText(t).then(() => done('Copied.'), () => done('Copy failed; select the text instead.')); }
  catch { done('Copy failed; select the text instead.'); }
}

// ---------- student mode ----------
const allVisible = () => S.mode === 'review' && S.showAll;
function selectHand(i: number) { S.cur = i; askReset(); restart(); }
function restart() {
  if (S.playing) { clearInterval(S.playing); S.playing = 0; }
  S.picks.clear(); S.auto.clear(); S.plan = { vals: {}, checked: false }; S.step = 0; $('#tabbody').innerHTML = ''; render();
}
/** The student makes every one of their own calls (not in Example hands), plus any call marked *. */
function studentCalls(s: HandScript, i: number): boolean {
  const a = s.auction[i];
  return !!a.studentDecides || (s.type !== 'example' && a.seat === s.student);
}
/** True when the student must act at this step before it can be shown. */
function pendingAt(L: Loaded, i: number): boolean {
  if (S.mode !== 'student' || !L.script) return false;
  const st = L.steps[i], s = L.script;
  if (!st || S.auto.has(i)) return false;
  if (st.kind === 'call') return studentCalls(s, st.i) && !S.picks.has(i);
  if (st.kind === 'card') return studentPlays(L, i) && legalCardsAt(L, i).length > 1 && !S.picks.has(i);
  if (st.kind === 'planning') return S.help && planQuestions(L).length > 0 && !S.plan.checked;
  return false;
}
function planQuestions(L: Loaded): { key: string; q: string; answer: Count }[] {
  const p = L.script!.planning; if (!p) return [];
  const out: { key: string; q: string; answer: Count }[] = [];
  if (p.trumpsOutstanding !== undefined) out.push({ key: 'trumps', q: 'How many trumps do the opponents hold?', answer: { min: p.trumpsOutstanding, max: p.trumpsOutstanding } });
  if (p.losers !== undefined) out.push({ key: 'losers', q: 'How many obvious losers do you have?', answer: p.losers });
  if (p.winners !== undefined) out.push({ key: 'winners', q: 'How many obvious winners do you have?', answer: p.winners });
  return out;
}
const countText = (c: Count) => c.min === c.max ? `${c.min}` : `${c.min} to ${c.max}`;
/** The per-suit catalogue: each suit's count and the job it needs. */
function catalogueHTML(p: PlanningPause) {
  const rows = SUITS.filter(x => p.bySuit?.[x] !== undefined || p.suitNotes?.[x]);
  if (!rows.length) return '';
  return `<ul class="catalogue">${rows.map(x => `<li>${suitSpan(x)} <b>${p.bySuit?.[x] ? countText(p.bySuit[x]!) : ''}</b>${p.suitNotes?.[x] ? ` ${prose(p.suitNotes[x]!)}` : ''}</li>`).join('')}</ul>`;
}
/** Cards the student may click now, for one seat, or null. */
function playableFor(L: Loaded, seat: Seat, pos: Pos): Set<string> | null {
  if (S.mode !== 'student' || !pendingAt(L, S.step)) return null;
  const st = L.steps[S.step]; if (st.kind !== 'card') return null;
  const s = L.script!, pc = s.play[st.t].cards[st.c];
  if (pc.seat !== seat) return null;
  return new Set(legalCardsAt(L, S.step).map(cardKey));
}
function sameCallText(a: string, b: Call) { const c = parseCallSafe(a); return !!c && callText(c) === callText(b); }
/** The student plays declarer's and dummy's cards when declaring, their own cards when defending, plus any card marked *. */
function studentPlays(L: Loaded, i: number): boolean {
  const s = L.script!, st = L.steps[i]; if (st.kind !== 'card') return false;
  const pc = s.play[st.t].cards[st.c], c = L.derived?.contract;
  if (pc.studentDecides) return true;
  if (!c) return false;
  if (c.declarer === s.student) return pc.seat === s.student || pc.seat === partner(s.student);
  if (partner(c.declarer) === s.student) return false; // student is dummy: partner plays
  return pc.seat === s.student;
}
function legalCardsAt(L: Loaded, i: number): Card[] {
  const s = L.script!, st = L.steps[i]; if (st.kind !== 'card') return [];
  const tr = s.play[st.t], pc = tr.cards[st.c];
  const played = position(L, i - 1).played;
  const mine = (s.deal[pc.seat] ?? []).filter(x => !played.has(cardKey(x)));
  const led = st.c > 0 ? tr.cards[0].card.suit : null;
  const follow = led ? mine.filter(x => x.suit === led) : [];
  return follow.length ? follow : mine;
}
/** Same card, or one that is just as good (touching cards in the same hand, counting cards already played). */
function cardRightAt(L: Loaded, i: number, pick: string): 'same' | 'equal' | false {
  const s = L.script!, st = L.steps[i]; if (st.kind !== 'card') return false;
  const pc = s.play[st.t].cards[st.c], c = parseCardSafe(pick); if (!c) return false;
  if (cardKey(c) === cardKey(pc.card)) return 'same';
  if (c.suit !== pc.card.suit) return false;
  const played = position(L, i - 1).played, hand = new Set((s.deal[pc.seat] ?? []).map(cardKey));
  const [a, b] = [RANKS.indexOf(c.rank), RANKS.indexOf(pc.card.rank)].sort((x, y) => x - y);
  for (let r = a + 1; r < b; r++) { const k = c.suit + RANKS[r]; if (!hand.has(k) && !played.has(k)) return false; }
  return 'equal';
}
function sameCardKey(a: string, b: Card) { const c = parseCardSafe(a); return !!c && cardKey(c) === cardKey(b); }
function studentPick(choice: string) {
  const L = S.hands[S.cur]; if (!pendingAt(L, S.step)) return;
  S.picks.set(S.step, choice);
  render();
  if (L.steps[S.step].kind === 'card' && !cardNeedsReading(L, S.step)) flowOn();
}
/** After a card, is there something on screen worth stopping for? A wrong key card, a lead nudge, a key point, or a trick note. */
function cardNeedsReading(L: Loaded, i: number): boolean {
  const st = L.steps[i]; if (st.kind !== 'card') return true;
  const tr = L.script!.play[st.t], pc = tr.cards[st.c], pick = S.picks.get(i);
  if (pc.key || (st.c === 3 && tr.note)) return true;
  if (pick === undefined) return false;
  const ok = cardRightAt(L, i, pick), pk = parseCardSafe(pick);
  if (pc.studentDecides) return !ok;
  return st.c === 0 && !ok && !!pk && pk.suit !== pc.card.suit;
}
/** Card play flows on its own: after the student's card, the next cards appear one by one until the student's next decision or something to read. */
let flowTimer = 0;
function flowOn() {
  clearTimeout(flowTimer);
  const cur = S.cur;
  const tick = (from: number) => {
    const L = S.hands[S.cur];
    const here = L.steps[S.step];
    if (S.cur !== cur || S.step !== from || L.steps[S.step + 1]?.kind !== 'card' || (here.kind === 'card' && here.c === 3)) return;
    go(S.step + 1);
    if (S.step === from || pendingAt(L, S.step) || L.steps[S.step].kind !== 'card' || cardNeedsReading(L, S.step)) return;
    const at = S.step; flowTimer = window.setTimeout(() => tick(at), 650);
  };
  const at = S.step; flowTimer = window.setTimeout(() => tick(at), 450);
}
function legalCalls(L: Loaded, i: number): Set<string> {
  const s = L.script!, out = new Set<string>(['Pass']);
  let last: Extract<Call, { kind: 'bid' }> | null = null, lastSeat: Seat | null = null, dbl = '';
  s.auction.slice(0, i).forEach(a => {
    if (a.call.kind === 'bid') { last = a.call; lastSeat = a.seat; dbl = ''; }
    else if (a.call.kind === 'double') dbl = 'X'; else if (a.call.kind === 'redouble') dbl = 'XX';
  });
  const me = s.auction[i].seat;
  const order = ['C', 'D', 'H', 'S', 'NT'];
  const rank = (l: number, st: string) => (l - 1) * 5 + order.indexOf(st);
  const lr = last ? rank((last as any).level, (last as any).strain) : -1;
  for (let l = 1; l <= 7; l++) for (const st of order) if (rank(l, st) > lr) out.add(l + st);
  if (last && side(lastSeat!) !== side(me) && !dbl) out.add('X');
  if (last && side(lastSeat!) === side(me) && dbl === 'X') out.add('XX');
  return out;
}
function biddingBox(L: Loaded, i: number) {
  const legal = legalCalls(L, i);
  const order: (Suit | 'NT')[] = ['C', 'D', 'H', 'S', 'NT'];
  const rows: string[] = [];
  for (let l = 1; l <= 7; l++) rows.push(`<div class="bbrow">${order.map(st => {
    const k = l + st, ok = legal.has(k);
    return `<button class="bb bid" data-call="${k}" ${ok ? '' : 'disabled'}>${l}${st === 'NT' ? '<span class="nt">NT</span>' : suitSpan(st as Suit)}</button>`;
  }).join('')}</div>`);
  const sp = (k: string, cls: string, t: string) => `<button class="bb ${cls}" data-call="${k}" ${legal.has(k) ? '' : 'disabled'}>${t}</button>`;
  return `<div class="bbox">${rows.join('')}<div class="bbrow specials">${sp('Pass', 'pass', 'Pass')}${sp('X', 'dbl', 'X')}${sp('XX', 'rdbl', 'XX')}</div></div>`;
}
function wrongNote(w: Record<string, string> | undefined, pick: string, isCall: boolean, right: string): string {
  if (!S.help) return '';
  const hit = w && Object.entries(w).find(([k]) => k !== '*' && (isCall ? sameCallText(k, parseCallSafe(pick)!) : sameCardKey(k, parseCardSafe(pick)!)));
  const text = hit?.[1] ?? w?.['*'] ?? '';
  const pass = isCall && right.includes('>Pass<');
  const opts = isCall
    ? (pass ? ['Most players would pass here.', 'Passing is the better choice here.', 'Not quite. This is a hand to pass.', 'Close, but a pass does the job here.', 'Experienced players would pass.']
            : [`Most players would bid ${right} here.`, `${right} is the call we're after.`, `Not quite. ${right} fits this hand better.`, `Close, but ${right} does the job here.`, `Experienced players would choose ${right}.`])
    : [`Most players would play ${right} here.`, `${right} is the card we want.`, `Not quite. ${right} works better here.`, `Close, but ${right} does the job here.`, `Experienced players would play ${right}.`];
  const L = S.hands[S.cur], seed = [...(L.script?.id ?? '') + S.step].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
  const lead = opts[seed % opts.length];
  return `<div class="verdict no"><b>${lead}</b>${text ? ` ${prose(text)}` : ''}</div>`;
}

function renderStudentCard(L: Loaded, pos: Pos) {
  const s = L.script!, st = L.steps[S.step], pend = pendingAt(L, S.step);
  const parts: string[] = [];
  if (st.kind === 'deal') {
    const intro = s.type === 'example' ? 'Watch this hand play itself. Press Autoplay, or step through with Next. It stops at the key moments.'
      : `${s.board ? `Board ${s.board}. ` : ''}You are ${SEAT_NAME[s.student]}. ${SEAT_NAME[s.dealer]} deals; ${VUL_TEXT[s.vulnerable]}. Press Next to start the auction. When it's your turn, you choose.`;
    const cid = s.concepts.includes(S.concept) ? S.concept : s.concepts[0];
    const con = cid ? conceptOf(s.lesson, cid) : undefined;
    if (con) parts.push(`<div class="ccard"><div class="lbl">Lesson ${s.lesson} · ${bidSyms(con.name)}</div><p>“${bidSyms(con.quote)}”</p><button class="linkbtn" id="tolesson">Lesson notes</button></div>`);
    parts.push(`<div class="headline">${prose(s.title)}</div><p>${intro}</p>`);
  } else if (st.kind === 'call') {
    const a = s.auction[st.i];
    if (pend) {
      parts.push(`<div class="headline">Your call</div><p class="muted">Tap a call. Hover over or tap any call in the auction to see what it means.</p>${biddingBox(L, st.i)}`);
    } else {
      const pick = S.picks.get(S.step);
      if (pick !== undefined) {
        parts.push(sameCallText(pick, a.call)
          ? `<div class="verdict yes"><b>Right: ${callHTML(a.call)}</b></div>`
          : `<div class="verdict-pick">You chose ${callHTML(parseCallSafe(pick)!)}.</div>` + wrongNote(a.whyNot, pick, true, callHTML(a.call, 'sm')));
      } else parts.push(`<div class="headline">${SEAT_NAME[a.seat]} ${callHTML(a.call)}</div>`);
      if (a.meaning) parts.push(`<div class="meaning">${prose(a.meaning)}</div>`);
      if (a.key) parts.push(`<div class="key"><div class="lbl">Key point</div>${prose(a.key)}</div>`);
    }
  } else if (st.kind === 'auctionRecap') {
    parts.push(`<div class="headline">Auction recap</div><p>${prose(s.auctionRecap)}</p>`);
  } else if (st.kind === 'planning') {
    const p = s.planning!, qs = planQuestions(L);
    parts.push(`<div class="headline">Stop and plan</div><p class="muted">Dummy is down. Before you play a card from it:</p>`);
    if (p.reminders.length) parts.push(`<ul class="plan">${p.reminders.map(r => `<li>${prose(r)}</li>`).join('')}</ul>`);
    if (qs.length) {
      parts.push(`<form id="planform" class="planform">${qs.map(q => {
        const v = S.plan.vals[q.key] ?? '';
        const n = Number(v), inRange = v !== '' && n >= q.answer.min && n <= q.answer.max, range = q.answer.min !== q.answer.max;
        const res = !S.plan.checked ? '' : inRange
          ? `<span class="ok-t">Right${range ? ` (anything from ${q.answer.min} to ${q.answer.max} is fair)` : ''}</span>`
          : `<span class="no-t">We'd say ${countText(q.answer)}</span>`;
        return `<label class="pq"><span>${q.q}</span><input type="number" inputmode="numeric" min="0" max="13" id="pq-${q.key}" value="${esc(v)}" ${S.plan.checked ? 'disabled' : ''}>${res}</label>`;
      }).join('')}${S.plan.checked ? '' : '<button class="btn primary" type="submit">Check my answers</button>'}</form>`);
      if (S.plan.checked && (p.bySuit || p.suitNotes)) parts.push(`<div class="catwrap"><div class="lbl">Suit by suit</div>${catalogueHTML(p)}</div>`);
    }
  } else if (st.kind === 'card') {
    const tr = s.play[st.t], pc = tr.cards[st.c];
    if (pend) {
      parts.push(`<div class="headline">Your play</div><p class="muted">Tap a card in ${pc.seat === s.student ? 'your hand' : 'dummy (' + SEAT_NAME[pc.seat] + ')'}. Cards you can't play are dimmed.</p>`);
    } else {
      const pick = S.picks.get(S.step);
      if (pick !== undefined) {
        const ok = cardRightAt(L, S.step, pick);
        const pk = parseCardSafe(pick)!, trump = L.derived!.contract?.strain;
        if (!pc.studentDecides && st.c === 0 && !ok && tr.okLeads?.includes(pk.suit)) {
          parts.push(`<div class="headline">You led <span class="cardtxt">${cardText(pk)}</span></div><div class="verdict yes">That might work, but we think <span class="cardtxt">${cardText(pc.card)}</span> is slightly better. Let's go that way.</div>`);
        } else if (!pc.studentDecides && st.c === 0 && !ok && pk.suit !== pc.card.suit) {
          // a lead in another suit is a change of plan: always nudge, using the trick's note as the reason
          const why = tr.note || (pc.card.suit === trump && pk.suit !== trump ? "Did you think about drawing the opponents' trumps first?" : '');
          parts.push(`<div class="verdict-pick">You led <span class="cardtxt">${cardText(pk)}</span>.</div>` + wrongNote(why ? { '*': why } : undefined, pick, false, `<span class="cardtxt">${cardText(pc.card)}</span>`) + `<p class="muted small">Play continues with the script's card.</p>`);
        } else if (!pc.studentDecides) {
          // not a key moment: no verdict; if the script's card differs, say quietly what is played
          parts.push(ok ? `<div class="headline">You play <span class="cardtxt">${cardText(parseCardSafe(pick)!)}</span></div>`
            : `<div class="headline">${SEAT_NAME[pc.seat]} plays <span class="cardtxt">${cardText(pc.card)}</span></div><p class="muted small">Play continues with the script's card.</p>`);
        } else parts.push(ok === 'equal'
          ? `<div class="verdict yes"><b>Fine: <span class="cardtxt">${cardText(parseCardSafe(pick)!)}</span> and <span class="cardtxt">${cardText(pc.card)}</span> are the same here.</b></div>`
          : ok
          ? `<div class="verdict yes"><b>Right: <span class="cardtxt">${cardText(pc.card)}</span></b></div>`
          : `<div class="verdict-pick">You chose <span class="cardtxt">${cardText(parseCardSafe(pick)!)}</span>.</div>` + wrongNote(pc.whyNot, pick, false, `<span class="cardtxt">${cardText(pc.card)}</span>`));
      } else parts.push(`<div class="headline">${SEAT_NAME[pc.seat]} ${st.c === 0 ? 'leads' : 'plays'} <span class="cardtxt">${cardText(pc.card)}</span></div>`);
      if (pc.key) parts.push(`<div class="key"><div class="lbl">Key point</div>${prose(pc.key)}</div>`);
      if (st.c === 3) {
        const w = L.derived!.winners[st.t];
        parts.push(`<div class="trickdone">${w ? `${SEAT_NAME[w]} wins the trick.` : ''}${tr.note ? `<div class="note">${prose(tr.note)}</div>` : ''}</div>`);
      }
    }
  } else if (st.kind === 'playRecap') {
    const d = L.derived!, c = d.contract!, need = c.level + 6;
    const res = d.declarerTricks >= need ? (d.declarerTricks > need ? `made with ${d.declarerTricks - need} overtrick${d.declarerTricks - need > 1 ? 's' : ''}` : 'made exactly') : `down ${need - d.declarerTricks}`;
    const judged = [...S.picks.entries()].filter(([i]) => { const x = L.steps[i]; return x.kind === 'call' || (x.kind === 'card' && s.play[x.t].cards[x.c].studentDecides); });
    const right = judged.filter(([i, p]) => { const x = L.steps[i]; return x.kind === 'call' ? sameCallText(p, s.auction[x.i].call) : x.kind === 'card' ? !!cardRightAt(L, i, p) : false; }).length;
    parts.push(`<div class="headline">The result: ${c.level}${c.strain === 'NT' ? 'NT' : SUIT_SYM[c.strain]} ${res}<span class="hscore">· ${scoreShort(L)}</span></div>`);
    if (judged.length) parts.push(`<p class="score">You made ${right} of ${judged.length} key decision${judged.length > 1 ? 's' : ''} the way most players would.</p>`);
    if (S.mode === 'student') progSet(s.id, { right, total: judged.length });
    const stu = S.mode === 'student', nx = stu ? nextInSet() : (S.cur < S.hands.length - 1 ? S.cur + 1 : -1);
    const lastOfSet = stu && nx < 0 && setOf(s.lesson).length > 1;
    parts.push(`<p>${prose(s.playRecap)}</p>${scoreHTML(L)}<div class="row"><button class="btn" id="again">Play it again</button>${stu ? `<button class="btn" id="backlesson">Back to the lesson</button>` : ''}${nx >= 0 ? `<button class="btn primary" id="nexthand" data-i="${nx}">Next hand</button>` : lastOfSet ? '<button class="btn primary" id="finish">Finish the lesson</button>' : ''}</div>`);
  }
  $('#stepcard').innerHTML = parts.join('');
  $('#stepcard').querySelectorAll<HTMLButtonElement>('[data-call]').forEach(b => b.onclick = () => studentPick(b.dataset.call!));
  const pf = document.querySelector<HTMLFormElement>('#planform');
  if (pf) pf.onsubmit = e => {
    e.preventDefault();
    for (const q of planQuestions(L)) S.plan.vals[q.key] = (document.querySelector<HTMLInputElement>('#pq-' + q.key)?.value ?? '').trim();
    if (planQuestions(L).some(q => S.plan.vals[q.key] === '')) { const f = pf.querySelector('input'); (f as HTMLInputElement)?.focus(); return; }
    S.plan.checked = true; render();
  };
  const ag = document.querySelector<HTMLButtonElement>('#again'); if (ag) ag.onclick = restart;
  const nh = document.querySelector<HTMLButtonElement>('#nexthand'); if (nh) nh.onclick = () => S.mode === 'student' ? playHand(Number(nh.dataset.i)) : selectHand(Number(nh.dataset.i));
  const fin = document.querySelector<HTMLButtonElement>('#finish'); if (fin) fin.onclick = () => { S.view = 'wrap'; render(); window.scrollTo(0, 0); };
  const bl = document.querySelector<HTMLButtonElement>('#backlesson'); if (bl) bl.onclick = () => openLesson(L.script!.lesson);
  const tl = document.querySelector<HTMLButtonElement>('#tolesson'); if (tl) tl.onclick = () => openNotes();
  const nb = $<HTMLButtonElement>('#next'), end = endAction();
  nb.textContent = end ? end.label + ' ›' : 'Next ›';
  nb.disabled = pend || (S.step >= L.steps.length - 1 && !end);
}
// What Next does once the hand is over: move on to the next hand (or finish the lesson), else nothing.
function endAction(): { label: string; run: () => void } | null {
  const L = S.hands[S.cur]; if (!L?.steps.length || S.step < L.steps.length - 1) return null;
  if (S.mode === 'student') {
    const nx = nextInSet();
    if (nx >= 0) return { label: 'Next hand', run: () => playHand(nx) };
    if (setOf(L.script!.lesson).length > 1) return { label: 'Finish', run: () => { S.view = 'wrap'; render(); window.scrollTo(0, 0); } };
    return null;
  }
  return S.cur < S.hands.length - 1 ? { label: 'Next hand', run: () => selectHand(S.cur + 1) } : null;
}
function nextStep() {
  const end = endAction(); if (end) return end.run();
  const L = S.hands[S.cur], was = L?.steps[S.step];
  go(S.step + 1);
  // leaving a completed trick: if the opponents lead, play on to the student's turn as usual
  const now = L?.steps[S.step];
  if (S.mode === 'student' && was?.kind === 'card' && was.c === 3 && now?.kind === 'card' && !pendingAt(L, S.step) && !cardNeedsReading(L, S.step)) flowOn();
}

// ---------- navigation ----------
function go(i: number) {
  const L = S.hands[S.cur]; if (!L?.steps.length) return;
  if (S.mode === 'student') {
    // never move past a decision the student hasn't made yet
    if (i > S.step) for (let k = S.step; k < i; k++) if (pendingAt(L, k)) { i = k; break; }
    if (!S.help) { const dir = i >= S.step ? 1 : -1; while (L.steps[i]?.kind === 'planning') i += dir; }
  }
  S.step = Math.max(0, Math.min(i, L.steps.length - 1));
  render();
}
function nextTrick(dir: 1 | -1) {
  const L = S.hands[S.cur]; let i = S.step + dir;
  while (i > 0 && i < L.steps.length - 1) { const st = L.steps[i]; if (st.kind !== 'card' || st.c === (dir > 0 ? 3 : 0)) break; i += dir; }
  go(i);
}
function toggleAuto() {
  if (S.playing) { clearInterval(S.playing); S.playing = 0; render(); return; }
  S.playing = setInterval(() => {
    const L = S.hands[S.cur];
    if (S.step >= L.steps.length - 1) { toggleAuto(); return; }
    // Autoplay plays cards (and skips the planning pause) for the student; it still stops for their calls
    if (S.mode === 'student') for (const k of [S.step, S.step + 1]) {
      const x = L.steps[k];
      if (x && (x.kind === 'card' || x.kind === 'planning') && pendingAt(L, k)) S.auto.add(k);
    }
    go(S.step + 1);
    const st = L.steps[S.step] as any;
    const s = L.script!;
    if (pendingAt(L, S.step)) { toggleAuto(); return; }
    const pauseHere = st.kind === 'call' ? s.auction[st.i].pause || (S.mode === 'student' && studentCalls(s, st.i))
      : st.kind === 'card' ? (S.mode === 'student' ? false : s.play[st.t].cards[st.c].pause || s.play[st.t].cards[st.c].studentDecides)
      : st.kind === 'planning' && S.mode === 'student' ? false
      : st.kind !== 'deal';
    if (pauseHere) toggleAuto();
  }, 900);
  render();
}
// ---------- Ask Claude: open a new claude.ai chat with what the student can see ----------
function askPrompt(L: Loaded): string {
  const s = L.script!, d = L.derived!, c = d.contract;
  const pend = pendingAt(L, S.step);
  const pos = shownPosition(L, pend);
  const cardsOf = (seat: Seat) => SUITS.map(su => {
    const r = (s.deal[seat] ?? []).filter(x => x.suit === su && !pos.played.has(cardKey(x)))
      .sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank)).map(x => x.rank === 'T' ? '10' : x.rank).join(' ');
    return `${SUIT_SYM[su]} ${r || '—'}`;
  }).join('   ');
  const seats: Seat[] = ['N', 'E', 'S', 'W'];
  const seen = seats.filter(x => isVisible(L, pos, x));
  const lines: string[] = [];
  lines.push(`I'm a beginning bridge student practicing on a scripted hand (${s.title.replace(/[*_]/g, '')}, Lesson ${s.lesson}). Please tutor me on it at a beginner's level, in plain words. Our system: Standard American, 5-card majors, 15-17 1NT with Stayman, 2NT = 21-22.`);
  lines.push(`Only use what I can see below. Don't guess at the hidden hands beyond what the bidding and the play so far show.`);
  lines.push('');
  lines.push(`I am ${SEAT_NAME[s.student]}. Dealer: ${SEAT_NAME[s.dealer]}. Vulnerable: ${s.vulnerable === 'none' ? 'none' : s.vulnerable}.`);
  for (const x of seen) {
    const role = c && (pos.trick || pos.final || pos.cleared !== undefined) ? (x === c.declarer ? ', declarer' : x === partner(c.declarer) ? ', dummy' : '') : '';
    lines.push(`${SEAT_NAME[x]}${x === s.student ? ' (me)' : ''}${role}: ${cardsOf(x)}`);
  }
  const calls = s.auction.slice(0, pos.callsShown).map(a => `${a.seat} ${callText(a.call)}`);
  lines.push('', `Auction so far: ${calls.length ? calls.join(', ') : '(none yet)'}`);
  if (c && pos.callsShown === s.auction.length) lines.push(`Contract: ${c.level}${c.strain === 'NT' ? 'NT' : SUIT_SYM[c.strain]}${c.doubled} by ${SEAT_NAME[c.declarer]}.`);
  const pt = pos.trick ?? (pos.final ? { t: s.play.length - 1, upto: 3 } : pos.cleared !== undefined ? { t: pos.cleared, upto: 3 } : null);
  if (pt) {
    lines.push(pos.final ? 'The play (all 13 tricks):' : 'Play so far:');
    for (let t = 0; t <= pt.t; t++) {
      const tr = s.play[t], upto = t < pt.t ? 3 : pt.upto;
      lines.push(`  Trick ${t + 1}: ${tr.cards.slice(0, upto + 1).map(pc => `${pc.seat} ${SUIT_SYM[pc.card.suit]}${pc.card.rank === 'T' ? '10' : pc.card.rank}`).join(', ')}`);
    }
  }
  const st = L.steps[S.step];
  if (pend) lines.push('', st.kind === 'call' ? "It's my turn to bid." : st.kind === 'card' ? "It's my turn to play a card." : '');
  return lines.join('\n');
}
// In-page chat through the viewer's own Claude (sample capability). Fallback: copy the hand.
const ASK = { open: false, hist: [] as { role: 'user' | 'assistant'; content: string }[], ctx: '', busy: false, sample: undefined as any };
(async () => { try { ASK.sample = await (window as any).claude?.use?.('sample') ?? null; } catch { ASK.sample = null; } })();
function askReset() { ASK.hist = []; ASK.ctx = ''; renderAsk(); }
function mdLite(t: string) {
  return esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
}
function renderAsk() {
  const el = $('#askpanel'); if (!el) return;
  el.hidden = !ASK.open; if (!ASK.open) return;
  const none = ASK.sample === null;
  el.innerHTML = `<div class="askhead"><b>Ask Claude about this hand</b><button class="btn ghost sm" id="askclose" aria-label="Close">✕</button></div>`
    + (none ? `<p class="muted small">Claude isn't available inside this page here. Copy the hand and paste it into a Claude chat instead.</p><button class="btn" id="askcopy">Copy the hand</button> <span id="askcopied" class="muted small"></span>`
    : `<p class="muted small">Claude sees only what you can see right now: your hand, dummy once it's down, the bidding and the play so far.</p>`
      + `<div class="asklog">${ASK.hist.map(m => `<div class="am ${m.role}"><p>${mdLite(m.role === 'user' ? m.content.split('\n\nMy question: ').pop()!.split('\n\nMy next question: ').pop()! : m.content)}</p></div>`).join('')}${ASK.busy && (!ASK.hist.length || ASK.hist[ASK.hist.length - 1].role === 'user') ? '<div class="am assistant"><p class="muted">Thinking...</p></div>' : ''}</div>`
      + `<form id="askform" class="askform"><textarea id="askq" rows="2" placeholder="For example: why does South bid 2♣ here?" ${ASK.busy ? 'disabled' : ''}></textarea><button class="btn primary" type="submit" ${ASK.busy ? 'disabled' : ''}>Send</button></form>`);
  $('#askclose').onclick = () => { ASK.open = false; renderAsk(); };
  const cp = document.getElementById('askcopy'); if (cp) cp.onclick = () => { const L = S.hands[S.cur]; copyText(askPrompt(L), '#askcopied'); };
  const f = document.getElementById('askform') as HTMLFormElement | null;
  if (f) f.onsubmit = e => { e.preventDefault(); askSend(); };
  const log = el.querySelector('.asklog'); if (log) log.scrollTop = log.scrollHeight;
}
async function askSend() {
  const q = ($<HTMLTextAreaElement>('#askq').value || '').trim(); if (!q || ASK.busy) return;
  const L = S.hands[S.cur]; if (!L?.script || !L.derived) return;
  const ctx = askPrompt(L);
  const content = ctx !== ASK.ctx
    ? (ASK.hist.length ? `The hand has moved on. Here it is as I see it now:\n\n${ctx}\n\nMy next question: ${q}` : `${ctx}\n\nMy question: ${q}`)
    : q;
  ASK.ctx = ctx;
  ASK.hist.push({ role: 'user', content }); ASK.busy = true; renderAsk();
  try {
    await ASK.sample(ASK.hist.slice(), {
      cache: false,
      onText: ({ text }: { text: string }) => {
        const last = ASK.hist[ASK.hist.length - 1];
        if (last.role === 'assistant') last.content = text; else ASK.hist.push({ role: 'assistant', content: text });
        renderAsk();
      },
    }).then((r: { text: string }) => {
      const last = ASK.hist[ASK.hist.length - 1];
      if (last.role === 'assistant') last.content = r.text; else ASK.hist.push({ role: 'assistant', content: r.text });
    });
  } catch (e: any) {
    const why = e?.code === 'not_granted' ? "Claude wasn't allowed for this page, so it can't answer here." : e?.code === 'rate_limited' ? 'Too many questions at once. Wait a moment and try again.' : "Claude couldn't answer just now. Please try again.";
    if (e?.code === 'not_granted') ASK.sample = null;
    const last = ASK.hist[ASK.hist.length - 1];
    if (last.role === 'user') ASK.hist.pop();
    ASK.busy = false; renderAsk(); const m = document.createElement('p'); m.className = 'muted small'; m.textContent = why; $('#askpanel').appendChild(m); return;
  }
  ASK.busy = false; renderAsk();
}
function askClaude() {
  ASK.open = !ASK.open; renderAsk();
  if (ASK.open) setTimeout(() => document.getElementById('askq')?.focus(), 0);
}

function claim() {
  const L = S.hands[S.cur];
  if (S.mode === 'student') for (let k = S.step; k < L.steps.length; k++) if (pendingAt(L, k)) S.auto.add(k);
  go(L.steps.length - 1);
}

// ---------- tap/hover meanings ----------
let tipTimer: any = 0;
function showTip(el: HTMLElement) {
  const text = el.dataset.tip; if (!text) return;
  const tip = $('#tip'); tip.innerHTML = prose(text); tip.hidden = false;
  const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2; x = Math.max(8, Math.min(x, window.innerWidth - tw - 8));
  let y = r.top - th - 8; if (y < 8) y = r.bottom + 8;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
  clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 6000);
}
function hideTip() { const t = $('#tip'); if (t) t.hidden = true; }
function initTips() {
  document.addEventListener('pointerover', e => { if ((e as PointerEvent).pointerType !== 'mouse') return; const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]'); if (el) showTip(el); });
  document.addEventListener('pointerout', e => { if ((e as PointerEvent).pointerType !== 'mouse') return; const el = (e.target as HTMLElement).closest('[data-tip]'); if (el && !el.contains(e.relatedTarget as Node)) hideTip(); });
  // taps: show after the click's re-render, anchored to the redrawn element
  document.addEventListener('click', e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]');
    if (!el) { hideTip(); return; }
    const step = el.dataset.step;
    setTimeout(() => { const now = step ? document.querySelector<HTMLElement>(`[data-tip][data-step="${step}"]`) : el; if (now) showTip(now); }, 0);
  });
  document.addEventListener('focusin', e => { const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tip]'); if (el) showTip(el); });
  window.addEventListener('scroll', hideTip, { passive: true });
}

// ---------- boot ----------
function boot() {
  S.hands = BUNDLED_HANDS.map(h => load(h.file, h.text));
  $<HTMLSelectElement>('#picker').onchange = e => { selectHand(Number((e.target as HTMLSelectElement).value)); };
  $('#first').onclick = () => go(0);
  $('#prevt').onclick = () => nextTrick(-1);
  $('#prev').onclick = () => go(S.step - 1);
  $('#next').onclick = nextStep;
  $('#nextt').onclick = () => nextTrick(1);
  $('#claim').onclick = claim;
  $('#ask').onclick = askClaude;
  $('#play').onclick = toggleAuto;
  $<HTMLInputElement>('#scrub').oninput = e => go(Number((e.target as HTMLInputElement).value));
  $<HTMLInputElement>('#showall').onchange = e => { S.showAll = (e.target as HTMLInputElement).checked; render(); };
  $<HTMLInputElement>('#showplayed').onchange = e => { S.showPlayed = (e.target as HTMLInputElement).checked; render(); };
  $('#checks').onclick = () => { S.tab = 'checks'; render(); };
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab as any; $('#tabbody').innerHTML = ''; render(); });
  document.addEventListener('keydown', e => {
    const t = e.target as HTMLElement; if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox' && (t as HTMLInputElement).type !== 'radio') return;
    if (e.key === 'ArrowRight') { e.shiftKey ? nextTrick(1) : nextStep(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { e.shiftKey ? nextTrick(-1) : go(S.step - 1); e.preventDefault(); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') claim();
  });
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(b => b.onclick = () => { S.mode = b.dataset.mode as any; lsSet('bridge-mode', S.mode); $('#tabbody').innerHTML = ''; restart(); });
  $<HTMLInputElement>('#help').onchange = e => { S.help = (e.target as HTMLInputElement).checked; lsSet('bridge-help', S.help ? 'on' : 'off'); render(); };
  $('#restart').onclick = restart;
  $('#menubtn').onclick = e => { e.stopPropagation(); const m = $('#menu'); m.hidden = !m.hidden; };
  document.addEventListener('click', e => { const m = document.getElementById('menu'); if (m && !m.hidden && !m.contains(e.target as Node) && !e.composedPath().includes(document.getElementById('tour')!)) m.hidden = true; });
  $('#preview').onclick = () => { S.mode = 'student'; lsSet('bridge-mode', S.mode); $('#tabbody').innerHTML = ''; restart(); S.view = 'home'; S.fresh = true; render(); window.scrollTo(0, 0); };
  $('#m-home').onclick = () => { $('#menu').hidden = true; closeNotes(); goHome(); };
  $('#m-tour').onclick = takeTour;
  $('#record').onclick = () => { void openRecorder(); };
  $('#m-review').onclick = () => { $('#menu').hidden = true; S.mode = S.mode === 'review' ? 'student' : 'review'; lsSet('bridge-mode', S.mode); $('#tabbody').innerHTML = ''; restart(); };
  window.addEventListener('resize', () => { if (tourStep >= 0) showTour(); });
  initTips();
  render();
  initStorage();
}
boot();
