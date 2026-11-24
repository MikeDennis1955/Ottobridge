import sys, subprocess
from runhand import load, SEATS
path, trump = sys.argv[1], sys.argv[2]
deal, play = load(path)
hs=' '.join('.'.join(deal[p]) for p in SEATS)
leader=play[0][0][0]
flat=[(t+1,s,c) for t,tr in enumerate(play) for s,c in tr]
for i,(tn,s,c) in enumerate(flat):
    if s not in 'NS' or tn>=12: continue
    seq=' '.join(x[2] for x in flat[:i])+' ?'
    out=subprocess.run(['./dd'],input=f"{hs}\n{trump} {leader}\n{seq}\n",capture_output=True,text=True,timeout=900).stdout
    line=[l for l in out.splitlines() if l.startswith('moves')]
    if not line: continue
    vals={t.split(':')[0]:int(t.split(':')[1]) for t in line[0].split()[1:]}
    if len(vals)<2: continue
    best=max(vals.values()); worse={k:v for k,v in vals.items() if v<best}
    if worse: print(tn, s, c, f"script={vals.get(c)} best={best}", 'costly:', ' '.join(f"{k}:{v}" for k,v in sorted(worse.items())), flush=True)
