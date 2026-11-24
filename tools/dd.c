// Simple double-dummy solver. Input (stdin):
// line1: N E S W hands, each as "S.H.D.C" with ranks 23456789TJQKA, '-' for void, separated by spaces
// line2: trump (S H D C or N) and leader (N E S W)
// line3: play sequence: cards like SA H2 ... (may be empty). Seat is implied by order.
// Output: DD NS tricks (total, including tricks already won) before each card and at the end.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

typedef uint64_t u64;
static int trump; // -1 for NT
static const char *RK = "23456789TJQKA";
static const char *SU = "SHDC";

#define TTBITS 22
#define TTSIZE (1u<<TTBITS)
typedef struct { u64 h[4]; uint8_t leader, lo, hi, used; } TTE;
static TTE *tt;

static u64 mix(const u64 *h, int leader){
  u64 x = h[0]*0x9E3779B97F4A7C15ULL ^ (h[1]+0x632BE59BD9B4E019ULL)*0xC2B2AE3D27D4EB4FULL;
  x ^= (h[2]*0x165667B19E3779F9ULL) ^ (h[3]*0x27D4EB2F165667C5ULL) ^ (u64)leader*0x85EBCA77ULL;
  x ^= x>>29; x*=0xBF58476D1CE4E5B9ULL; x^=x>>32; return x;
}
static void norm(const u64 *h, u64 *o){
  o[0]=o[1]=o[2]=o[3]=0;
  for(int s=0;s<4;s++){ int r2=0;
    for(int r=0;r<13;r++){ for(int p=0;p<4;p++) if(h[p]>>(s*13+r)&1){ o[p]|=1ULL<<(s*13+r2); r2++; break; } } }
}
static TTE* ttfind(const u64 *h0, int leader, int create){
  u64 hh[4]; norm(h0,hh); const u64 *h=hh;
  u64 k = mix(h,leader); unsigned i = (unsigned)(k & (TTSIZE-1));
  for(int p=0;p<16;p++){
    TTE *e=&tt[(i+p)&(TTSIZE-1)];
    if(!e->used){ if(create){ memcpy(e->h,h,sizeof(e->h)); e->leader=leader; e->used=1; e->lo=0; e->hi=13; return e;} return NULL; }
    if(e->leader==leader && !memcmp(e->h,h,sizeof(e->h))) return e;
  }
  if(create){ TTE *e=&tt[i]; memcpy(e->h,h,sizeof(e->h)); e->leader=leader; e->used=1; e->lo=0; e->hi=13; return e; }
  return NULL;
}

static int suitbits(u64 h, int s){ return (int)((h>>(s*13))&0x1FFF); }

static int winner(int leader, const int *c){
  int led=c[0]/13, best=0, bk=-1;
  for(int i=0;i<4;i++){ int s=c[i]/13, k;
    if(trump>=0 && s==trump) k=200+c[i]%13; else if(s==led) k=100+c[i]%13; else k=c[i]%13;
    if(k>bk){bk=k;best=i;} }
  return (leader+best)&3;
}

static int gen(const u64 *h, int seat, int led, int *out){
  u64 all=h[0]|h[1]|h[2]|h[3]; int n=0; int ss[4], ns=0;
  if(led>=0 && suitbits(h[seat],led)) ss[ns++]=led; else for(int s=0;s<4;s++) if(suitbits(h[seat],s)) ss[ns++]=s;
  for(int k=0;k<ns;k++){ int s=ss[k]; int m=suitbits(h[seat],s), a=suitbits(all,s); int prev=0;
    for(int r=12;r>=0;r--){ if(m>>r&1){ if(!prev) out[n++]=s*13+r; prev=1;} else if(a>>r&1) prev=0; } }
  return n;
}

static int search(u64 *h, int leader, int *played, int np, int target);

static int node(u64 *h, int leader, int *played, int np, int target){
  int seat=(leader+np)&3, led= np? played[0]/13 : -1; int ns=(seat%2==0);
  int mv[13]; int n=gen(h,seat,led,mv);
  if(np>0 && n>1){
    // find current winner of trick so far
    int wi=0; int bk=-1; for(int i=0;i<np;i++){ int s=played[i]/13,k; if(trump>=0&&s==trump)k=200+played[i]%13; else if(s==led)k=100+played[i]%13; else k=played[i]%13; if(k>bk){bk=k;wi=i;} }
    int partner_win = (((leader+wi)&3)%2)==(seat%2);
    int sc[13];
    for(int i=0;i<n;i++){ int c=mv[i], s=c/13, k; if(trump>=0&&s==trump)k=200+c%13; else if(s==led)k=100+c%13; else k=c%13;
      int beats = k>bk;
      if(partner_win) sc[i]= -k;               // play low
      else if(beats) sc[i]= 1000 - k;          // cheapest winner first
      else sc[i]= -k; }
    for(int i=1;i<n;i++){ int c=mv[i], v=sc[i], j=i-1; while(j>=0 && sc[j]<v){ mv[j+1]=mv[j]; sc[j+1]=sc[j]; j--; } mv[j+1]=c; sc[j+1]=v; }
  }
  // ordering: if following and partner winning, play low; else try high first
  for(int i=0;i<n;i++){ int c=mv[i];
    h[seat]&=~(1ULL<<c); played[np]=c; int r;
    if(np==3){ int w=winner(leader,played); r=search(h,w,played,0,target-((w%2==0)?1:0)); }
    else r=search(h,leader,played,np+1,target);
    h[seat]|=(1ULL<<c);
    if(ns && r) return 1; if(!ns && !r) return 0; }
  return !ns;
}

static int search(u64 *h, int leader, int *played, int np, int target){
  if(np==0){
    int rem=__builtin_popcountll(h[0]);
    if(target<=0) return 1; if(target>rem) return 0;
    TTE *e=ttfind(h,leader,0);
    if(e){ if(target<=e->lo) return 1; if(target>e->hi) return 0; }
    int saved[4]; memcpy(saved,played,sizeof(saved));
    int res=node(h,leader,played,0,target);
    memcpy(played,saved,sizeof(saved));
    e=ttfind(h,leader,1);
    if(res){ if(target>e->lo) e->lo=target; } else { if(target-1<e->hi) e->hi=target-1; }
    return res;
  }
  return node(h,leader,played,np,target);
}

static int value(u64 *h, int leader, int *played, int np){
  int tot=(__builtin_popcountll(h[0]|h[1]|h[2]|h[3])+np)/4; int lo=0, hi=tot;
  int pc[4];
  while(lo<hi){ int mid=(lo+hi+1)/2; memcpy(pc,played,sizeof(pc)); if(search(h,leader,pc,np,mid)) lo=mid; else hi=mid-1; }
  return lo;
}

static int pcard(const char *t){ const char *s=strchr(SU,t[0]); const char *r=strchr(RK,t[1]); if(!s||!r) return -1; return (int)(s-SU)*13+(int)(r-RK); }

int main(){
  tt=calloc(TTSIZE,sizeof(TTE));
  char buf[4096]; u64 h[4]={0};
  for(int p=0;p<4;p++){ if(scanf("%s",buf)!=1) return 1; int s=0; for(char *q=buf;*q;q++){ if(*q=='.'){s++;continue;} if(*q=='-') continue; char *r=strchr((char*)RK,*q); if(!r){fprintf(stderr,"bad rank %c\n",*q);return 1;} h[p]|=1ULL<<(s*13+(r-RK)); } }
  char tr[4], ld[4]; scanf("%s %s",tr,ld);
  trump = tr[0]=='N' ? -1 : (int)(strchr(SU,tr[0])-SU);
  int leader=(int)(strchr("NESW",ld[0])-"NESW");
  int played[4]; int np=0; int nswon=0; int idx=0;
  
  while(scanf("%s",buf)==1){
    if(buf[0]=='?'){
      int seat=(leader+np)&3; int led=np?played[0]/13:-1; u64 all=h[seat];
      printf("moves");
      for(int c=0;c<52;c++){ if(!(all>>c&1)) continue; if(led>=0 && c/13!=led && suitbits(h[seat],led)) continue;
        u64 hh[4]; memcpy(hh,h,sizeof(hh)); int pl[4]; memcpy(pl,played,sizeof(pl)); int n2=np, l2=leader, won=nswon;
        hh[seat]&=~(1ULL<<c); pl[n2++]=c; int v;
        if(n2==4){ int w=winner(l2,pl); if(w%2==0) won++; v=value(hh,w,pl,0)+won; }
        else v=value(hh,l2,pl,n2)+won;
        printf(" %c%c:%d",SU[c/13],RK[c%13],v); }
      printf("\n"); return 0; }
    int c=pcard(buf); int seat=(leader+np)&3;
    if(c<0 || !(h[seat]>>c&1)){ printf("ERR card %s not held by %c\n",buf,"NESW"[seat]); return 2; }
    if(np>0){ int led=played[0]/13; if(c/13!=led && suitbits(h[seat],led)){ printf("ERR revoke %s by %c\n",buf,"NESW"[seat]); return 2; } }
    int before=value(h,leader,played,np)+nswon;
    h[seat]&=~(1ULL<<c); played[np++]=c; int after;
    if(np==4){ int w=winner(leader,played); if(w%2==0) nswon++; leader=w; np=0; after=value(h,leader,played,0)+nswon; }
    else after=value(h,leader,played,np)+nswon;
    idx++;
    printf("%d %c %s %d %d%s\n", (idx-1)/4+1, "NESW"[seat], buf, before, after, before!=after?" *":"");
    fflush(stdout);
  }
  printf("final %d\n", nswon);
  return 0;
}
