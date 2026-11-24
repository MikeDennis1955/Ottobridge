// Record play: Mike plays all four hands by clicking cards; the result is saved as script-format play lines.
import type { Card, Seat, Strain, HandScript } from './model';
import { next, trickWinner, RANKS, SUITS, SUIT_SYM, cardKey, side } from './rules';

export interface RecTrick { cards: { seat: Seat; card: Card }[]; note: string }
export interface Recording { handId: string; tricks: RecTrick[]; plan: string; at: string; play: string }

const NAME: Record<Seat, string> = { N: 'North', E: 'East', S: 'South', W: 'West' };
const red = (s: string) => s === 'H' || s === 'D';
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);

export function playText(tricks: RecTrick[]): string {
  return tricks.map((t, i) => {
    const line = `  ${String(i + 1).padEnd(3)} ${t.cards.map(c => `${c.seat} ${c.card.suit}${c.card.rank}`).join('  ')}`;
    return t.note.trim() ? `${line}\n      note: ${t.note.trim()}` : line;
  }).join('\n');
}

export class Recorder {
  tricks: RecTrick[] = [];
  plan = '';
  savedAt = '';
  dirty = false;
  autoDef = (() => { try { return localStorage.getItem('rec-autodef') !== 'off'; } catch { return true; } })();
  hideDef = (() => { try { return localStorage.getItem('rec-hidedef') !== 'off'; } catch { return true; } })();
  constructor(public s: HandScript, public trump: Strain, public declarer: Seat, public contract: string, public el: HTMLElement,
              public onSave: (r: Recording) => Promise<string>, public onClose: () => void) {}

  load(r: Recording | null) { if (r) { this.savedAt = r.at ? new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''; this.tricks = r.tricks.map(t => ({ cards: t.cards.map(c => ({ ...c })), note: t.note })); this.plan = r.plan ?? ''; } }

  private played() { const s = new Set<string>(); for (const t of this.tricks) for (const c of t.cards) s.add(c.seat + cardKey(c.card)); return s; }
  private remaining(seat: Seat) { const p = this.played(); return this.s.deal[seat].filter(c => !p.has(seat + cardKey(c))); }
  private cur(): RecTrick | null { const t = this.tricks[this.tricks.length - 1]; return t && t.cards.length < 4 ? t : null; }
  private toPlay(): Seat | null {
    if (this.tricks.length === 13 && !this.cur()) return null;
    const t = this.cur();
    if (t) return next(t.cards[t.cards.length - 1].seat);
    const last = this.tricks[this.tricks.length - 1];
    if (!last) return next(this.declarer);
    return last.cards[trickWinner(last.cards, this.trump)].seat;
  }
  private legal(seat: Seat, c: Card) {
    const t = this.cur(); if (!t) return true;
    const led = t.cards[0].card.suit;
    return c.suit === led || !this.remaining(seat).some(x => x.suit === led);
  }
  private tally() {
    let ns = 0, ew = 0;
    for (const t of this.tricks) if (t.cards.length === 4) { const w = t.cards[trickWinner(t.cards, this.trump)].seat; (w === 'N' || w === 'S') ? ns++ : ew++; }
    return { ns, ew };
  }

  private isDef(seat: Seat) { return side(seat) !== side(this.declarer); }
  private beats(seat: Seat, c: Card) {
    const t = this.cur()!; const cs = [...t.cards, { seat, card: c }];
    return trickWinner(cs, this.trump) === cs.length - 1;
  }
  /** A defender's card: the script's card for this trick if still legal, else a plain beginner-style rule. */
  private pick(seat: Seat): Card | null {
    const rem = this.remaining(seat), legal = rem.filter(c => this.legal(seat, c));
    if (legal.length <= 1) return legal[0] ?? null;
    const t = this.cur(), n = t ? this.tricks.length : this.tricks.length + 1;
    // Use the script's card only while this trick (and, for a lead, the previous one) matches the script so far.
    const same = (a: { seat: Seat; card: Card }[], b: { seat: Seat; card: Card }[]) => a.length <= b.length && a.every((x, i) => x.seat === b[i].seat && cardKey(x.card) === cardKey(b[i].card));
    const st = this.s.play[n - 1], prevOk = n === 1 || same(this.tricks[n - 2].cards, this.s.play[n - 2].cards);
    const pos = t ? t.cards.length : 0;
    const sc = st && prevOk && same(t ? t.cards : [], st.cards) && st.cards[pos]?.seat === seat ? st.cards[pos].card : undefined;
    if (sc && legal.some(c => cardKey(c) === cardKey(sc))) return sc;
    const r = (c: Card) => RANKS.indexOf(c.rank);
    const low = (cs: Card[]) => cs.reduce((a, b) => (r(b) > r(a) ? b : a));
    const bySuit = (cs: Card[]) => SUITS.map(su => cs.filter(c => c.suit === su)).filter(g => g.length);
    const longest = (cs: Card[]) => bySuit(cs).sort((a, b) => (b.length - a.length) || ((a[0].suit === this.trump ? 1 : 0) - (b[0].suit === this.trump ? 1 : 0)))[0];
    if (!t) {
      // Lead: a later scripted lead by this seat if still held, else the longest suit (top of touching honors, else low).
      const g = longest(legal).sort((a, b) => r(a) - r(b));
      return g.length > 1 && r(g[1]) === r(g[0]) + 1 && r(g[0]) <= 4 ? g[0] : low(g);
    }
    const w = trickWinner(t.cards, this.trump), pardWins = side(t.cards[w].seat) === side(seat);
    const winners = legal.filter(c => this.beats(seat, c)).sort((a, b) => r(b) - r(a)); // cheapest first
    const following = legal[0].suit === t.cards[0].card.suit;
    if (pardWins || (following && t.cards.length === 1) || !winners.length) {
      const side_ = legal.filter(c => c.suit !== this.trump);
      if (following) return low(legal);
      // Discard: the lowest card outside trumps, from the longer suit on ties; never an honor when a spot card will do.
      // Discard from the suit that matters least: one partner also guards, or where we outnumber declarer's longest holding.
      const pool = side_.length ? side_ : legal;
      const opp = [this.declarer, next(this.declarer, 2)], pard = next(seat, 2);
      const score = (su: string) => {
        const mine = pool.filter(c => c.suit === su).length;
        const theirs = Math.max(...opp.map(o => this.remaining(o).filter(c => c.suit === su).length));
        const pardLen = this.remaining(pard).filter(c => c.suit === su).length;
        return (pardLen >= theirs ? 10 : 0) + mine - theirs;
      };
      const best = Math.max(...pool.map(c => score(c.suit)));
      return low(pool.filter(c => score(c.suit) === best));
    }
    return winners[0];
  }
  private autoPlay() {
    for (let g = 0; g < 52 && this.autoDef; g++) {
      const seat = this.toPlay(); if (!seat || !this.isDef(seat)) return;
      const c = this.pick(seat); if (!c) return;
      let t = this.cur(); if (!t) { t = { cards: [], note: '' }; this.tricks.push(t); }
      t.cards.push({ seat, card: c });
    }
  }

  play(seat: Seat, c: Card) {
    if (this.toPlay() !== seat || !this.legal(seat, c)) return;
    let t = this.cur();
    if (!t) { t = { cards: [], note: '' }; this.tricks.push(t); }
    t.cards.push({ seat, card: c });
    this.dirty = true;
    this.render();
  }
  undo() {
    // With auto defense, step back past the defenders' cards to declarer's side's last card.
    for (let g = 0; g < 52; g++) {
      const t = this.tricks[this.tricks.length - 1]; if (!t) break;
      const c = t.cards.pop()!; if (!t.cards.length) this.tricks.pop();
      if (!this.autoDef || !this.isDef(c.seat)) break;
    }
    this.dirty = true;
    this.render();
  }

  render() {
    this.autoPlay();
    const turn = this.toPlay();
    const handHTML = (seat: Seat) => {
      const rem = this.remaining(seat);
      const label = `<div class="rname">${NAME[seat]}${seat === this.declarer ? ' (declarer)' : seat === next(this.declarer, 2) ? ' (dummy)' : ''}</div>`;
      // Table view: with the defense automatic, its hands stay hidden (as at the table) until all 13 tricks are played.
      if (this.autoDef && this.hideDef && this.isDef(seat) && turn) {
        return `<div class="rhand r-${seat} rhidden">${label}<div class="muted small">${rem.length} cards, hidden</div></div>`;
      }
      const rows = SUITS.map(su => {
        const cs = rem.filter(c => c.suit === su).sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));
        return `<div class="rrow"><span class="sym ${red(su) ? 'red' : 'blk'}">${SUIT_SYM[su]}</span>${cs.map(c => {
          const ok = turn === seat && this.legal(seat, c);
          return `<button class="rcard${ok ? ' ok' : ''}" ${ok ? '' : 'disabled'} data-rs="${seat}" data-rc="${c.suit}${c.rank}">${c.rank === 'T' ? '10' : c.rank}</button>`;
        }).join('') || '<span class="muted">—</span>'}</div>`;
      }).join('');
      return `<div class="rhand r-${seat}${turn === seat ? ' turn' : ''}">${label}${rows}</div>`;
    };
    const shown = this.cur() ?? this.tricks[this.tricks.length - 1];
    const centre = shown ? shown.cards.map(c => `<div class="rc-${c.seat}"><span class="sym ${red(c.card.suit) ? 'red' : 'blk'}">${SUIT_SYM[c.card.suit]}</span>${c.card.rank === 'T' ? '10' : c.card.rank}</div>`).join('') : '';
    const { ns, ew } = this.tally();
    const list = this.tricks.map((tr, i) => {
      const done = tr.cards.length === 4, w = done ? tr.cards[trickWinner(tr.cards, this.trump)].seat : null;
      return `<li><span class="rtl">${i + 1}. ${tr.cards.map(c => `${c.seat} <span class="sym ${red(c.card.suit) ? 'red' : 'blk'}">${SUIT_SYM[c.card.suit]}</span>${c.card.rank}`).join(' · ')}${w ? ` <b>→ ${w}</b>` : ''}</span><input class="rnote" data-ti="${i}" placeholder="Note (optional): why this lead or play" value="${esc(tr.note)}"></li>`;
    }).join('');
    this.el.innerHTML = `<div class="rpanel">
      <div class="rhead"><b>Record play: ${esc(this.s.id)}, ${this.contract} by ${NAME[this.declarer]}</b><span class="muted small">Click each card in turn; only legal cards are live. ${turn ? `${NAME[turn]} to play.` : 'All 13 tricks played.'} Tricks: NS ${ns}, EW ${ew}.</span>
        <label class="small"><input type="checkbox" id="rauto"${this.autoDef ? ' checked' : ''}> Defense plays itself</label>${this.autoDef ? `<label class="small"><input type="checkbox" id="rhide"${this.hideDef ? ' checked' : ''}> Hide the defenders' hands</label>` : ''}<span class="rbtns"><button class="btn sm" id="rundo">Undo</button><button class="btn sm" id="rclear">Start over</button><button class="btn primary sm" id="rsave">${this.savedAt ? 'Save again' : 'Save'}</button><span id="rmsg" class="rmsg${this.dirty ? ' bad' : this.savedAt ? ' ok' : ''}">${this.dirty ? (this.savedAt ? `Changes not saved (last save ${this.savedAt})` : 'Not saved yet') : this.savedAt ? `✓ Saved ${this.savedAt}` : ''}</span><button class="btn ghost sm" id="rclose">Close</button></span></div>
      <div class="rtable">${handHTML('N')}${handHTML('W')}<div class="rcentre">${centre}</div>${handHTML('E')}${handHTML('S')}</div>
      <label class="rplan">Your plan in a sentence (optional)<input id="rplan" value="${esc(this.plan)}" placeholder="e.g. Set up the clubs, keep the ♥A as an entry."></label>
      <ol class="rlist">${list}</ol>
      </div>`;
    this.el.querySelectorAll<HTMLButtonElement>('[data-rc]').forEach(b => b.onclick = () => {
      const k = b.dataset.rc!; this.play(b.dataset.rs as Seat, { suit: k[0] as any, rank: k[1] as any });
    });
    this.el.querySelectorAll<HTMLInputElement>('.rnote').forEach(inp => inp.oninput = () => { this.tricks[Number(inp.dataset.ti)].note = inp.value; });
    (this.el.querySelector('#rplan') as HTMLInputElement).oninput = e => { this.plan = (e.target as HTMLInputElement).value; };
    (this.el.querySelector('#rundo') as HTMLElement).onclick = () => this.undo();
    (this.el.querySelector('#rauto') as HTMLInputElement).onchange = e => {
      this.autoDef = (e.target as HTMLInputElement).checked;
      try { localStorage.setItem('rec-autodef', this.autoDef ? 'on' : 'off'); } catch { /* ignore */ }
      this.render();
    };
    const hide = this.el.querySelector('#rhide') as HTMLInputElement | null;
    if (hide) hide.onchange = () => {
      this.hideDef = hide.checked;
      try { localStorage.setItem('rec-hidedef', this.hideDef ? 'on' : 'off'); } catch { /* ignore */ }
      this.render();
    };
    (this.el.querySelector('#rclear') as HTMLElement).onclick = () => { this.tricks = []; this.dirty = true; this.render(); };
    (this.el.querySelector('#rclose') as HTMLElement).onclick = () => this.onClose();
    (this.el.querySelector('#rsave') as HTMLElement).onclick = async () => {
      const msg = this.el.querySelector('#rmsg') as HTMLElement;
      msg.textContent = 'Saving…'; msg.className = 'rmsg';
      const res = await this.onSave({ handId: this.s.id, tricks: this.tricks, plan: this.plan, at: new Date().toISOString(), play: playText(this.tricks) });
      const ok = res.startsWith('Saved at');
      if (ok) { this.dirty = false; this.savedAt = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); (this.el.querySelector('#rsave') as HTMLElement).textContent = 'Save again'; }
      msg.textContent = ok ? `✓ Saved ${this.savedAt}. Tell Claude when you're done.` : res;
      msg.className = 'rmsg ' + (ok ? 'ok' : 'bad');
    };
  }
}
