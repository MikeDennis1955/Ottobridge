import sys, json
from gen import *
cfg=json.loads(sys.argv[1])
ns={'N':cfg['N'],'S':cfg['S']}
g=complete(ns,cfg.get('seed',1),quiet)
for i in range(cfg.get('n',10)):
    E,W=next(g); h=dict(ns,E=E,W=W)
    res=[f"{c}:{start(h,c.split('/')[1],c.split('/')[2])}" for c in cfg['contracts']]
    print(i,'E',E,'W',W,*res, flush=True)
