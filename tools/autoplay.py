"""Auto-play a deal: each side picks among its double-dummy-optimal cards using natural heuristics.
Usage from Python: play(hands, trump, leader, opening_lead) -> list of tricks [(seat, card)...]."""
import subprocess
R = '23456789TJQKA'; SU = 'SHDC'; SEATS = 'NESW'

def hs_str(h):
    return ' '.join('.'.join(s if s else '-' for s in h[p]) for p in SEATS)

def moves(hands, trump, leader, seq):
    out = subprocess.run(['./dd'], input=f"{hs_str(hands)}\n{trump} {leader}\n{' '.join(seq)} ?\n",
                         capture_output=True, text=True).stdout
    line = [l for l in out.splitlines() if l.startswith('moves')][0]
    return {t.split(':')[0]: int(t.split(':')[1]) for t in line.split()[1:]}

def rank(c): return R.index(c[1])

def play(hands, trump, leader, opening_lead, force=None):
    """force: dict {(trick, seat): card} to override choices."""
    force = force or {}
    held = {p: {SU[i] + c for i, s in enumerate(hands[p]) for c in s} for p in SEATS}
    seq = []; tricks = []; ld = leader
    tr = None if trump == 'N' else trump
    for t in range(13):
        trick = []
        for k in range(4):
            seat = SEATS[(SEATS.index(ld) + k) % 4]
            if t == 0 and k == 0:
                c = opening_lead
            elif (t + 1, seat) in force:
                c = force[(t + 1, seat)]
            else:
                mv = moves(hands, trump, leader, seq)
                ns = seat in 'NS'
                best = max(mv.values()) if ns else min(mv.values())
                opt = [c for c, v in mv.items() if v == best]
                c = choose(opt, seat, trick, held, tr, ns)
            held[seat].discard(c)
            trick.append((seat, c)); seq.append(c)
        # winner
        led = trick[0][1][0]
        def key(c):
            if tr and c[0] == tr: return 200 + rank(c)
            if c[0] == led: return 100 + rank(c)
            return rank(c)
        w = max(trick, key=lambda x: key(x[1]))[0]
        tricks.append(trick); ld = w
    return tricks

def choose(opt, seat, trick, held, tr, ns):
    partner = SEATS[(SEATS.index(seat) + 2) % 4]
    if not trick:
        # leading: declarer side draws trumps if opponents hold any
        opp = [SEATS[(SEATS.index(seat) + 1) % 4], SEATS[(SEATS.index(seat) + 3) % 4]]
        if ns and tr and any(c[0] == tr for o in opp for c in held[o]):
            tl = [c for c in opt if c[0] == tr]
            if tl: return max(tl, key=rank)
        opp_tr = tr and any(c[0] == tr for o in opp for c in held[o])
        if ns and tr and not opp_tr:
            nontr = [c for c in opt if c[0] != tr]
            if nontr: opt = nontr
        # prefer top of a winning/sequence card, else lowest of longest suit
        def score(c):
            suit = [x for x in held[seat] if x[0] == c[0]]
            others_higher = any(x[0] == c[0] and rank(x) > rank(c) for p in SEATS if p != seat for x in held[p])
            top = not any(x[0] == c[0] and rank(x) > rank(c) for x in held[seat])
            return (not others_higher, top, len(suit), rank(c) if not others_higher else -rank(c))
        return max(opt, key=score)
    led = trick[0][1][0]
    def key(c):
        if tr and c[0] == tr: return 200 + rank(c)
        if c[0] == led: return 100 + rank(c)
        return rank(c)
    cur = max(trick, key=lambda x: key(x[1]))
    partner_winning = cur[0] == partner
    following = [c for c in opt if c[0] == led]
    if following:
        if partner_winning:
            return min(following, key=rank)
        winners = [c for c in following if key(c) > key(cur[1])]
        if winners and len(trick) >= 2:
            return min(winners, key=rank)
        return min(following, key=rank)
    # can't follow
    ruffs = [c for c in opt if tr and c[0] == tr]
    if ruffs and not partner_winning:
        return min(ruffs, key=rank)
    disc = [c for c in opt if not (tr and c[0] == tr)] or opt
    # discard lowest card from the suit where we hold the fewest high cards
    return min(disc, key=lambda c: (rank(c), ))

def fmt(tricks):
    lines = []
    for i, t in enumerate(tricks, 1):
        lines.append('%-3d ' % i + '  '.join('%s %s' % (s, c) for s, c in t))
    return '\n'.join(lines)

def play_from(hands, trump, prefix_text):
    """prefix_text: tricks like 'E C9 S C7 W CJ N CQ' one per line. Continues with auto choices."""
    lines = [l.split() for l in prefix_text.strip().splitlines()]
    force = {}
    for i, t in enumerate(lines, 1):
        if t[0].isdigit(): t = t[1:]
        for j in range(0, len(t), 2):
            force[(i, t[j])] = t[j + 1]
    leader = lines[0][0] if not lines[0][0].isdigit() else lines[0][1]
    lead = force[(1, leader)]
    return play(hands, trump, leader, lead, force)
