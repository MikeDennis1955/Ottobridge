import sys, re, subprocess
SEATS='NESW'
def load(path):
    txt=open(path).read()
    deal={}; play=[]; sec=None; trump=None; contract=None
    for line in txt.splitlines():
        s=line.split('#')[0].rstrip()
        if not s: continue
        if not s.startswith(' '):
            sec=s.split(':')[0].strip(); continue
        t=s.split()
        if sec=='deal' and t[0] in SEATS and len(t)==5: deal[t[0]]=t[1:]
        if sec=='play' and t[0].isdigit():
            cards=[c.rstrip('*') for c in t[1:]]; play.append([(cards[i],cards[i+1]) for i in range(0,len(cards),2)])
    return deal, play
def run(deal, trump, play, leader=None):
    hs=' '.join('.'.join(x if x!='-' else '-' for x in deal[p]) for p in SEATS)
    leader = leader or play[0][0][0]
    seq=' '.join(c for tr in play for _,c in tr)
    inp=f"{hs}\n{trump} {leader}\n{seq}\n"
    return subprocess.run(['./dd'],input=inp,capture_output=True,text=True,timeout=900).stdout
if __name__=='__main__':
    deal,play=load(sys.argv[1]); print(run(deal,sys.argv[2],play))
