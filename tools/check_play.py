import sys
R='23456789TJQKA'
def run(hs,trump,leader,play):
    hands={k:{('SHDC'[i],c) for i in range(4) for c in v.split()[i]} for k,v in hs.items()}
    ns=0
    for i,line in enumerate(play.strip().splitlines(),1):
        t=line.split(); seats=t[0::2]; cards=[(c[0],c[1]) for c in t[1::2]]
        assert seats[0]==leader,(i,seats[0],leader)
        assert ''.join(seats)==('NESWNESW'['NESW'.index(leader):])[:4],i
        led=cards[0][0]
        for s,c in zip(seats,cards):
            assert c in hands[s],(i,s,c)
            if c[0]!=led: assert not any(x[0]==led for x in hands[s]),(i,s,'revoke')
            hands[s].remove(c)
        k=lambda c:(2 if c[0]==trump else 1 if c[0]==led else 0,R.index(c[1]))
        leader=seats[max(range(4),key=lambda j:k(cards[j]))]; ns+=leader in 'NS'
        print(i,leader)
    print('NS',ns)
run({'N':'K83 A62 85 KQ954','E':'62 QT93 JT64 J83','S':'A75 K74 KQ73 A72','W':'QJT94 J85 A92 T6'},None,'W',"""
W SQ N S3 E S2 S SA
S CA W C6 N C4 E C3
S C2 W CT N CK E C8
N D5 E D4 S DK W DA
W SJ N SK E S6 S S5
N CQ E CJ S C7 W D2
N C9 E H3 S H4 W D9
N C5 E H9 S D3 W H5
N HA E HT S H7 W H8
N H2 E HQ S HK W HJ
S DQ W S4 N D8 E D6
S D7 W S9 N H6 E DT
E DJ S S7 W ST N S8""")
