import json
R="E:/ClaudeCraft/CreateCraft_7_App_Integration_Test/"
ST=R+"SoundCraft/stems/"
SR=48000; L=[]
def c(cid,**p): L.append(cid+" "+json.dumps(p))
c("session.new",name="VOLTERRA X1 Soundtrack",sample_rate=SR,bit_depth=24)
for name,inst in (("Pad","subtractive_synth"),("Bass","subtractive_synth"),("Arp","subtractive_synth"),("Drums","drum_synth")):
    c("track.new",kind="instrument",name=name,instrument=inst)
for t in (1,2,3,4): c("midi.new_clip",track=t,start=0,end=20*SR)
BAR=3840; BEAT=960
prog=[("Am",[57,60,64],33),("F",[53,57,60],29),("C",[48,52,55],36),("G",[55,59,62],31)]
chords=[prog[i%4] for i in range(8)]+[prog[0],prog[0]]
n=0
for b,(nm,tri,root) in enumerate(chords):
    t0=b*BAR
    for p in tri: c("midi.note_add",clip=5,pitch=p+12,start_ticks=t0,length_ticks=BAR-60,velocity=62)
    if b>=1:
        for e in range(8): c("midi.note_add",clip=6,pitch=root,start_ticks=t0+e*480,length_ticks=400,velocity=96 if e%2==0 else 78)
    if b>=3:  # arp from t=6 s
        seq=[tri[0]+12,tri[1]+12,tri[2]+12,tri[1]+24]
        for s in range(16): c("midi.note_add",clip=7,pitch=seq[s%4]+(12 if s%8>=4 else 0),start_ticks=t0+s*240,length_ticks=220,velocity=70 if s%4 else 88)
    if b>=3:
        for beat in range(4):
            c("midi.note_add",clip=8,pitch=36,start_ticks=t0+beat*BEAT,length_ticks=400,velocity=110)
            c("midi.note_add",clip=8,pitch=42,start_ticks=t0+beat*BEAT+480,length_ticks=200,velocity=70)
            if b>=5 and beat%2==1: c("midi.note_add",clip=8,pitch=38,start_ticks=t0+beat*BEAT,length_ticks=400,velocity=100)
# transition and final hits (crash 49)
for sec in (6.0,10.5,15.0,18.6):
    tk=int(sec*1920); c("midi.note_add",clip=8,pitch=49,start_ticks=tk,length_ticks=1800,velocity=120)
    c("midi.note_add",clip=8,pitch=36,start_ticks=tk,length_ticks=960,velocity=127)
# FX + VO
def sm(s): return int(round(s*SR))
c("file.import_audio",path=ST+"fx-whoosh.wav",at=sm(5.0),new_tracks=True)       # track 5
c("file.import_audio",path=ST+"fx-whoosh.wav",at=sm(9.6),new_tracks=True)
c("file.import_audio",path=ST+"fx-riser.wav",at=sm(12.6),new_tracks=True)
c("file.import_audio",path=ST+"fx-impact.wav",at=sm(15.0),new_tracks=True)
c("file.import_audio",path=ST+"fx-impact.wav",at=sm(18.6),new_tracks=True)
c("file.import_audio",path=ST+"vo-introducing.wav",at=sm(1.7),new_tracks=True)    # track 6
c("file.import_audio",path=ST+"vo-future.wav",at=sm(15.5),new_tracks=True)
open("sc_script.txt","w").write("\n".join(L))
print(len(L),"lines")
import sys
vols={1:-12,2:-8,3:-12,4:-9,10:-9,13:-9,16:-9,19:-8,22:-8,25:-2,28:-2}
V=json.loads(sys.argv[1]) if len(sys.argv)>1 else vols
lines=open("sc_script.txt").read().split("\n")
for t,db in V.items(): lines.append("mix.volume "+json.dumps({"tracks":[int(t)],"db":db}))
out=sys.argv[2] if len(sys.argv)>2 else R+"SoundCraft/volterra-x1-soundtrack-v1.wav"
lines.append("file.bounce_mix "+json.dumps({"path":out,"start":0,"end":960000,"bit_depth":24}))
open("sc_script.txt","w").write("\n".join(lines))
