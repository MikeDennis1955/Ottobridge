import random, subprocess, sys, json
R='23456789TJQKA'; S='SHDC'
HCP={'A':4,'K':3,'Q':2,'J':1}
def hcp(h): return sum(HCP.get(c,0) for s in h for c in s)
def dd(hands, trump, leader, seq=''):
    hs=' '.join('.'.join(s if s else '-' for s in hands[p]) for p in 'NESW')
    out=subprocess.run(['./dd'],input=f"{hs}\n{trump} {leader}\n{seq}\n",capture_output=True,text=True).stdout
    return out
def start(hands,trump,leader):
    out=dd(hands,trump,leader,'?')
    vals=[int(t.split(':')[1]) for t in out.split()[1:]]
    return max(vals) if leader in 'NS' else min(vals)
def complete(ns, seed, ok):
    """ns: {'N':[s,h,d,c], 'S':[...]} strings; returns random E/W completions passing ok()"""
    rnd=random.Random(seed)
    used={(i,c) for p in ns.values() for i,s in enumerate(p) for c in s}
    rest=[(i,c) for i in range(4) for c in R if (i,c) not in used]
    while True:
        rnd.shuffle(rest)
        e=sorted(rest[:13]); w=sorted(rest[13:])
        def fmt(cs): return [''.join(sorted((c for i,c in cs if i==k), key=lambda c:-R.index(c))) for k in range(4)]
        E=fmt(e); W=fmt(w)
        if ok(E,W): yield E,W
def quiet(E,W, maxh=11):
    for h in (E,W):
        if hcp(h)>maxh: return False
        for s in h:
            if len(s)>=6 and hcp([s])>=5: return False
            if len(s)>=5 and hcp(h)>=10: return False
    return True
