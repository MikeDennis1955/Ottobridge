import sys, json
from autoplay import *
c=json.loads(sys.argv[1])
h={k:c[k] for k in 'NESW'}
print(fmt(play(h,c['trump'],c['leader'],c['lead'])))
