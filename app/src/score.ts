// Scoring one deal on its own (Chicago / duplicate style): no running total, game and partscore bonuses paid on the spot.
import type { Contract, Strain, Vulnerability } from './model';

export interface ScoreLine { label: string; pts: number }
export interface HandScore { side: 'NS' | 'EW'; points: number; lines: ScoreLine[]; made: boolean }

const STRAIN_NAME: Record<Strain, string> = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades', NT: 'no-trump' };
const perTrick = (s: Strain) => (s === 'C' || s === 'D' ? 20 : 30);

export function isVul(side: 'NS' | 'EW', v: Vulnerability) { return v === 'both' || v === side; }

export function scoreHand(c: Contract, vul: Vulnerability, tricks: number): HandScore {
  const side: 'NS' | 'EW' = c.declarer === 'N' || c.declarer === 'S' ? 'NS' : 'EW';
  const v = isVul(side, vul), mult = c.doubled === 'XX' ? 4 : c.doubled === 'X' ? 2 : 1;
  const need = c.level + 6, lines: ScoreLine[] = [];
  const vtxt = v ? 'vulnerable' : 'not vulnerable';
  if (tricks >= need) {
    const base = c.strain === 'NT' ? 40 + 30 * (c.level - 1) : perTrick(c.strain) * c.level;
    const ts = base * mult;
    const dbl = mult > 1 ? `, ${c.doubled === 'XX' ? 'redoubled ×4' : 'doubled ×2'}` : '';
    lines.push({ label: c.strain === 'NT'
      ? `${c.level} trick${c.level > 1 ? 's' : ''} bid in no-trump (40 for the first${c.level > 1 ? ', 30 for each other' : ''}${dbl})`
      : `${c.level} trick${c.level > 1 ? 's' : ''} bid in ${STRAIN_NAME[c.strain]} × ${perTrick(c.strain)}${dbl}`, pts: ts });
    if (ts >= 100) lines.push({ label: `Game bonus (${vtxt})`, pts: v ? 500 : 300 });
    else lines.push({ label: 'Partscore bonus (less than 100 for tricks bid)', pts: 50 });
    if (c.level === 6) lines.push({ label: `Small slam bonus (${vtxt})`, pts: v ? 750 : 500 });
    if (c.level === 7) lines.push({ label: `Grand slam bonus (${vtxt})`, pts: v ? 1500 : 1000 });
    if (mult > 1) lines.push({ label: `For making a ${c.doubled === 'XX' ? 'redoubled' : 'doubled'} contract`, pts: mult === 4 ? 100 : 50 });
    const over = tricks - need;
    if (over > 0) {
      const each = mult === 1 ? perTrick(c.strain) : (v ? 200 : 100) * (mult / 2);
      lines.push({ label: `${over} overtrick${over > 1 ? 's' : ''} × ${each}`, pts: over * each });
    }
    return { side, points: lines.reduce((a, l) => a + l.pts, 0), lines, made: true };
  }
  const down = need - tricks;
  let pts = 0;
  if (mult === 1) { pts = down * (v ? 100 : 50); lines.push({ label: `Down ${down}, ${v ? 100 : 50} for each trick short (${vtxt})`, pts }); }
  else {
    for (let i = 1; i <= down; i++) pts += v ? (i === 1 ? 200 : 300) : (i === 1 ? 100 : i <= 3 ? 200 : 300);
    pts *= mult / 2;
    lines.push({ label: `Down ${down}, ${c.doubled === 'XX' ? 'redoubled' : 'doubled'} (${vtxt}: ${v ? '200 for the first, 300 for each more' : '100, then 200, 200, then 300 each'}${mult === 4 ? ', ×2 for the redouble' : ''})`, pts });
  }
  return { side: side === 'NS' ? 'EW' : 'NS', points: pts, lines, made: false };
}

// What the same tricks would have scored in a higher contract the side didn't bid: game, or a slam.
export function missedBonus(c: Contract, vul: Vulnerability, tricks: number): { contract: Contract; score: HandScore } | null {
  if (c.doubled) return null;
  const gameLevel = c.strain === 'NT' ? 3 : c.strain === 'H' || c.strain === 'S' ? 4 : 5;
  const can = tricks - 6;
  let lvl = 0;
  if (can >= 6 && c.level < 6) lvl = 6; // a small slam they could have bid
  else if (can >= gameLevel && c.level < gameLevel) lvl = gameLevel;
  if (!lvl) return null;
  const alt = { ...c, level: lvl };
  return { contract: alt, score: scoreHand(alt, vul, tricks) };
}
