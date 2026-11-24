// Rules engine and script validator.
import type { Call, Card, Contract, HandScript, Seat, Strain, Suit } from './model';
import { parseCall, parseCard, type Issue } from './parse';

export const SEATS: Seat[] = ['N', 'E', 'S', 'W'];
export const SUITS: Suit[] = ['S', 'H', 'D', 'C'];
export const RANKS = 'AKQJT98765432';
const STRAIN_ORDER: Strain[] = ['C', 'D', 'H', 'S', 'NT'];

export const next = (s: Seat, k = 1): Seat => SEATS[(SEATS.indexOf(s) + k) % 4];
export const partner = (s: Seat) => next(s, 2);
export const side = (s: Seat): 'NS' | 'EW' => (s === 'N' || s === 'S' ? 'NS' : 'EW');
export const cardKey = (c: Card) => c.suit + c.rank;
export const sameCard = (a: Card, b: Card) => a.suit === b.suit && a.rank === b.rank;
export const hcp = (cards: Card[]) => cards.reduce((t, c) => t + ({ A: 4, K: 3, Q: 2, J: 1 } as any)[c.rank] || t, 0);
const bidRank = (c: Call) => (c.kind === 'bid' ? (c.level - 1) * 5 + STRAIN_ORDER.indexOf(c.strain) : -1);

export function callText(c: Call): string {
  if (c.kind === 'pass') return 'Pass';
  if (c.kind === 'double') return 'X';
  if (c.kind === 'redouble') return 'XX';
  return c.level + c.strain;
}

/** Contract from a complete auction, or null if passed out / incomplete. */
export function contractOf(dealer: Seat, calls: Call[]): Contract | null {
  let lastBid = -1, doubled: Contract['doubled'] = '';
  calls.forEach((c, i) => {
    if (c.kind === 'bid') { lastBid = i; doubled = ''; }
    else if (c.kind === 'double') doubled = 'X';
    else if (c.kind === 'redouble') doubled = 'XX';
  });
  if (lastBid < 0) return null;
  const b = calls[lastBid] as Extract<Call, { kind: 'bid' }>;
  const bidder = next(dealer, lastBid);
  let declarer = bidder;
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i], s = next(dealer, i);
    if (c.kind === 'bid' && c.strain === b.strain && side(s) === side(bidder)) { declarer = s; break; }
  }
  return { level: b.level, strain: b.strain, doubled, declarer };
}

export function trickWinner(cards: { seat: Seat; card: Card }[], trump: Strain): number {
  let w = 0;
  for (let i = 1; i < cards.length; i++) {
    const a = cards[w].card, b = cards[i].card;
    const beats = b.suit === a.suit ? RANKS.indexOf(b.rank) < RANKS.indexOf(a.rank) : b.suit === trump;
    if (beats) w = i;
  }
  return w;
}

export interface Derived {
  contract: Contract | null;
  winners: Seat[];              // winner of each scripted trick
  declarerTricks: number;
  trumpsOutstanding?: number;
}

export function validate(s: HandScript): { errors: Issue[]; warnings: Issue[]; derived: Derived } {
  const errors: Issue[] = [], warnings: Issue[] = [];
  const E = (msg: string) => errors.push({ msg }), W = (msg: string) => warnings.push({ msg });

  // ---- deal: 13 each, 52 distinct
  const owner = new Map<string, Seat>();
  for (const seat of SEATS) {
    const h = s.deal[seat];
    if (!h) { E(`Deal: ${seat} hand is missing`); continue; }
    if (h.length !== 13) E(`Deal: ${seat} has ${h.length} cards, not 13`);
    for (const c of h) {
      const k = cardKey(c);
      if (owner.has(k)) E(`Deal: ${fmt(c)} appears in both ${owner.get(k)} and ${seat}`);
      else owner.set(k, seat);
    }
  }
  if (owner.size === 52) { /* complete */ } else {
    const missing = SUITS.flatMap(su => [...RANKS].map(r => su + r)).filter(k => !owner.has(k));
    if (missing.length) E(`Deal: missing ${missing.map(k => fmt(parseCard(k)!)).join(' ')}`);
  }

  // ---- auction
  const calls = s.auction.map(a => a.call);
  let lastBid = -1, lastBidSeat: Seat | null = null, state: '' | 'X' | 'XX' = '';
  let ended = false;
  s.auction.forEach((a, i) => {
    const expect = next(s.dealer, i);
    const label = `Call ${i + 1} (${a.seat} ${callText(a.call)})`;
    if (ended) { E(`${label}: the auction was already over`); return; }
    if (a.seat !== expect) E(`${label}: it is ${expect}'s turn, not ${a.seat}'s`);
    const c = a.call;
    if (c.kind === 'bid') {
      if (bidRank(c) <= lastBid) E(`${label}: not higher than the previous bid`);
      lastBid = bidRank(c); lastBidSeat = expect; state = '';
    } else if (c.kind === 'double') {
      if (!lastBidSeat || side(lastBidSeat) === side(expect) || state) E(`${label}: double is not allowed here`);
      state = 'X';
    } else if (c.kind === 'redouble') {
      if (state !== 'X' || side(lastBidSeat!) !== side(expect)) E(`${label}: redouble is not allowed here`);
      state = 'XX';
    }
    const tail = calls.slice(0, i + 1);
    const passes = tail.length - 1 - findLastIndex(tail, x => x.kind !== 'pass');
    if ((lastBid >= 0 && passes >= 3) || (lastBid < 0 && passes >= 4)) ended = true;
    if (a.whyNot) for (const k of Object.keys(a.whyNot))
      if (k !== '*' && !parseCall(k)) W(`${label}: wrong-pick note for "${k}", which isn't a call`);
    if (a.studentDecides && a.seat !== s.student) W(`${label}: marked for the student, but the student sits ${s.student}`);
  });
  if (!ended && s.auction.length) E('Auction: not finished (needs three passes after the last bid)');
  const contract = ended ? contractOf(s.dealer, calls) : null;

  // ---- play
  const winners: Seat[] = [];
  let declarerTricks = 0;
  if (contract) {
    const trump = contract.strain;
    const dummy = partner(contract.declarer);
    const played = new Set<string>();
    let leader = next(contract.declarer);
    if (s.play.length !== 13) E(`Play: ${s.play.length} tricks scripted; every script plays all 13`);
    s.play.forEach((t, ti) => {
      const T = `Trick ${t.number}`;
      if (t.number !== ti + 1) E(`${T}: expected trick number ${ti + 1}`);
      if (t.cards.length !== 4) { E(`${T}: has ${t.cards.length} cards, not 4`); return; }
      t.cards.forEach((pc, i) => {
        const expect = next(leader, i);
        const k = cardKey(pc.card);
        if (pc.seat !== expect) E(`${T}: card ${i + 1} should be ${expect}'s, not ${pc.seat}'s` + (i === 0 ? ` (${leader} won the last trick)` : ''));
        if (owner.get(k) !== pc.seat) E(`${T}: ${pc.seat} doesn't hold ${fmt(pc.card)}` + (owner.has(k) ? ` (${owner.get(k)} does)` : ''));
        else if (played.has(k)) E(`${T}: ${fmt(pc.card)} was already played`);
        if (i > 0) {
          const led = t.cards[0].card.suit;
          if (pc.card.suit !== led) {
            const still = (s.deal[pc.seat] ?? []).some(c => c.suit === led && !played.has(cardKey(c)) && !t.cards.slice(0, i).some(x => sameCard(x.card, c)));
            if (still) E(`${T}: ${pc.seat} must follow suit (still holds a ${SUIT_NAME[led]}) but plays ${fmt(pc.card)}`);
          }
        }
        if (pc.studentDecides) {
          const ok = pc.seat === s.student || (pc.seat === dummy && contract.declarer === s.student);
          if (!ok) W(`${T}: ${fmt(pc.card)} is marked for the student, but the student doesn't play ${pc.seat}'s cards`);
        }
        if (pc.whyNot) for (const key of Object.keys(pc.whyNot))
          if (key !== '*' && !parseCard(key)) W(`${T}: wrong-pick note for "${key}", which isn't a card`);
      });
      t.cards.forEach(pc => played.add(cardKey(pc.card)));
      const w = t.cards[trickWinner(t.cards, trump)].seat;
      winners.push(w);
      if (side(w) === side(contract.declarer)) declarerTricks++;
      leader = w;
    });
  } else if (s.play.length) E('Play: no contract, so the play cannot be checked');

  // ---- planning numbers
  let trumpsOutstanding: number | undefined;
  if (contract && contract.strain !== 'NT') {
    const ours = [...(s.deal[contract.declarer] ?? []), ...(s.deal[partner(contract.declarer)] ?? [])]
      .filter(c => c.suit === contract.strain).length;
    trumpsOutstanding = 13 - ours;
    if (s.planning?.trumpsOutstanding !== undefined && s.planning.trumpsOutstanding !== trumpsOutstanding)
      E(`Planning: trumps out says ${s.planning.trumpsOutstanding}, but the opponents hold ${trumpsOutstanding}`);
  }
  const pl = s.planning;
  if (pl?.bySuit) {
    const parts = Object.values(pl.bySuit), lo = parts.reduce((a, c) => a + c!.min, 0), hi = parts.reduce((a, c) => a + c!.max, 0);
    const tot = pl.winners ?? pl.losers;
    if (tot && (tot.min !== lo || tot.max !== hi))
      W(`Planning: the suits add up to ${lo === hi ? lo : `${lo}-${hi}`}, but the total says ${tot.min === tot.max ? tot.min : `${tot.min}-${tot.max}`}`);
  }
  if (contract && contract.strain === 'NT' && s.planning?.trumpsOutstanding !== undefined)
    W('Planning: "trumps out" given for a no-trump contract');

  // ---- text claims like "10 tricks" in the last note or recap
  if (contract && s.play.length === 13) {
    const texts = [s.play[12]?.note, s.playRecap].filter(Boolean) as string[];
    for (const tx of texts) {
      const m = /(\d+) tricks?(?::| and)/.exec(tx);
      if (m && Number(m[1]) !== declarerTricks && Number(m[1]) !== 13 - declarerTricks)
        W(`Text says "${m[0]}", but declarer's side took ${declarerTricks}`);
    }
    const need = contract.level + 6;
    if (declarerTricks < need) W(`Contract goes down: ${declarerTricks} tricks, needed ${need}. Intended?`);
  }

  if (s.type === 'exercise' && !s.auction.some(a => a.studentDecides) && !s.play.some(t => t.cards.some(c => c.studentDecides)))
    W('Exercise has no call or card marked * for the student');

  return { errors, warnings, derived: { contract, winners, declarerTricks, trumpsOutstanding } };
}

export const SUIT_SYM: Record<Suit, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
export const SUIT_NAME: Record<Suit, string> = { S: 'spade', H: 'heart', D: 'diamond', C: 'club' };
export const fmt = (c: Card) => SUIT_SYM[c.suit] + c.rank;
function findLastIndex<T>(a: T[], f: (x: T) => boolean) { for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return i; return -1; }
