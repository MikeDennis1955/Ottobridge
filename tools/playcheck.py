"""playcheck.py HAND... : flag every scripted card that changes the double-dummy result.

Run from a folder holding the compiled `dd` (gcc -O2 -o dd dd.c).
For each hand: contract, double-dummy par at trick 1, the scripted result, and each card that
changed the DD result, labelled from declarer's point of view:
  SLIP  a card by declarer's side that loses a trick (double dummy)
  GIFT  a card by the defense that gives declarer a trick (double dummy)
DD sees all four hands, so a SLIP may be a sound single-dummy play (a finesse that loses) and
needs judgment. LEAD is a blind opening lead that costs a trick: usually fine. A GIFT is almost always worth a look: real defenders rarely hand over tricks.
"""
import sys, re, subprocess
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from runhand import load, run

SUITS = {'♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C', 'S': 'S', 'H': 'H', 'D': 'D', 'C': 'C'}

def contract(path):
    t = open(path).read()
    auc = t[t.index('\nauction:\n'):t.index('\nauction recap:')] if '\nauction recap:' in t else t[t.index('\nauction:\n'):t.index('\nplay:\n')]
    calls = re.findall(r'^  ([NESW]) (\S+)', auc, re.M)
    bids = [(s, c.rstrip('*')) for s, c in calls if re.match(r'[1-7]', c)]
    side = lambda s: 'NS' if s in 'NS' else 'EW'
    last = bids[-1]; lvl, strain = int(last[1][0]), last[1][1:].rstrip('X')
    decl = next(s for s, c in bids if side(s) == side(last[0]) and c[1:].rstrip('X') == strain)
    trump = 'N' if strain.startswith('N') else SUITS[strain[0]]
    return lvl, strain, decl, trump

def notes(path):
    t = open(path).read(); p = t[t.index('\nplay:\n'):]
    out, cur = {}, None
    for l in p.splitlines():
        m = re.match(r'^  (\d+)\s', l)
        if m: cur = int(m.group(1))
        elif cur and 'note:' in l: out[cur] = l.split('note:', 1)[1].strip()
        if l.startswith('play recap'): break
    return out

def check(path):
    hid = path.rsplit('/', 1)[-1][:-5]
    try:
        lvl, strain, decl, trump = contract(path)
    except Exception as e:
        return f'{hid}: no contract ({e})\n'
    deal, play = load(path)
    out = run(deal, trump, play)
    ns = decl in 'NS'
    rows = [l.split() for l in out.splitlines() if re.match(r'\d+ [NESW] ', l)]
    if not rows: return f'{hid}: solver error: {out.strip()[:200]}\n'
    par = int(rows[0][3]); fin = int(re.search(r'final (\d+)', out).group(1))
    if not ns: par, fin = 13 - par, 13 - fin
    need = lvl + 6
    nt = notes(path)
    lines = [f'{hid}: {lvl}{strain} by {decl}. DD par {par} tricks, scripted {fin} ({"+" if fin >= need else ""}{fin - need}).']
    for r in rows:
        if len(r) < 6: continue
        trick, seat, card, b, a = int(r[0]), r[1], r[2], int(r[3]), int(r[4])
        d = (a - b) if ns else (b - a)            # change in declarer's DD tricks
        mine = (seat in 'NS') == ns
        tag = 'SLIP' if mine and d < 0 else ('LEAD' if trick == 1 and r is rows[0] else 'GIFT') if not mine and d > 0 else '????'
        lines.append(f'  {tag} trick {trick}: {seat} {card} ({"+" if d > 0 else ""}{d})' + (f'   [note: {nt[trick]}]' if trick in nt else ''))
    return '\n'.join(lines) + '\n'

if __name__ == '__main__':
    for f in sys.argv[1:]:
        print(check(f), flush=True)
