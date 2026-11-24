// Data model for hand scripts. One HandScript = one text file.

export type Seat = 'N' | 'E' | 'S' | 'W';
export type Suit = 'S' | 'H' | 'D' | 'C';
export type Rank = 'A' | 'K' | 'Q' | 'J' | 'T' | '9' | '8' | '7' | '6' | '5' | '4' | '3' | '2';
export type Strain = Suit | 'NT';

export interface Card { suit: Suit; rank: Rank }       // written "SQ" or "♠Q"

export type Hand = Card[];                              // 13 cards
export type Deal = Record<Seat, Hand>;

export type HandType = 'exercise' | 'example' | 'counting';
export type Vulnerability = 'none' | 'NS' | 'EW' | 'both';

export type Call =
  | { kind: 'bid'; level: 1 | 2 | 3 | 4 | 5 | 6 | 7; strain: Strain }
  | { kind: 'pass' }
  | { kind: 'double' }
  | { kind: 'redouble' };

/** Teaching text attached to one call or one card. All optional. */
export interface Annotation {
  meaning?: string;                 // one-line hover/tap meaning (calls)
  key?: string;                     // key point, shown to everyone after this step
  whyNot?: Record<string, string>;  // wrong pick ("3NT", "SA") -> one-line note
  pause?: boolean;                  // Example hands: autoplay stops here
}

export interface ScriptedCall extends Annotation {
  seat: Seat;
  call: Call;
  studentDecides: boolean;          // marked with * in the text file
}

export interface ScriptedCard extends Annotation {
  seat: Seat;
  card: Card;
  studentDecides: boolean;
  countMark?: 'loser' | 'winner';   // Counting hands: tally changes on this card
}

export interface Trick {
  number: number;                   // 1..13
  cards: ScriptedCard[];            // 4, in play order, starting with the leader
  note?: string;                    // shown after the trick completes
  okLeads?: Suit[];                 // other suits fine to lead here ("ok: H D"): no nudge
}

/** Asked after dummy is tabled. Numeric answers are checked; the rest are reminders. */
/** A count the student estimates. Any answer from min to max is accepted ("7-9" in the file; "7" means 7-7). */
export interface Count { min: number; max: number }

export interface PlanningPause {
  trumpsOutstanding?: number;       // validator recomputes this from the deal
  losers?: Count;                   // obvious losers, counted in the long-trump hand
  winners?: Count;                  // obvious winners: certain tricks, including ones set up by giving up the lead
  bySuit?: Partial<Record<Suit, Count>>;   // the per-suit catalogue behind the total
  suitNotes?: Partial<Record<Suit, string>>; // the job each suit needs, e.g. "Ruff the third heart in dummy."
  reminders: string[];              // e.g. "What is the contract?"
}

export interface Contract {         // derived from the auction, not written in the file
  level: number; strain: Strain;
  doubled: '' | 'X' | 'XX';
  declarer: Seat;
}

export interface HandScript {
  id: string;                       // e.g. "L05-A"
  title: string;
  type: HandType;
  lesson: number;
  concepts: string[];               // e.g. ["5.3"]
  student: Seat;                    // seat shown at the bottom of the table
  dealer: Seat;
  vulnerable: Vulnerability;
  board?: number;          // duplicate board number; sets dealer and vulnerability
  deal: Deal;
  auction: ScriptedCall[];
  auctionRecap?: string;
  planning?: PlanningPause;
  play: Trick[];                    // always all 13 tricks
  playRecap?: string;
}

/** Mike's review notes, stored by the reviewer table, one per flagged step. */
export interface ReviewNote {
  handId: string;
  step: string;                     // "deal", "call 7", "trick 4 card 2", "recap"
  flag: 'ok' | 'problem' | 'question';
  text: string;
  at: string;                       // ISO time
}
