import json,sys,os
sys.path.insert(0,'.')
from mcpc import MCP
R="E:/ClaudeCraft/CreateCraft_7_App_Integration_Test/"
T=254016000000
m=MCP([r"C:\Program Files\FilmCraft\filmcraft-cli.exe","--data-dir",R+"_work/filmcraft-data","mcp"])
m.cmd("file.newProject",name="VOLTERRA X1 Promo")
def imp(p): return m.tool("media_import",{"paths":[R+p]})["items"][0]
reveal=imp("EffectCraft/volterra-x1-logo-reveal.mp4"); blue=imp("LightCraft/volterra-x1-electric-blue.png")
noir=imp("LightCraft/volterra-x1-deep-noir.png"); card=imp("DesignCraft/volterra-x1-endcard.png"); music=imp("SoundCraft/volterra-x1-soundtrack-v1.wav")
m.cmd("file.newSequence",name="VOLTERRA X1 Promo 20s",fromItem=reveal)
s=m.tool("sequence_inspect",{}); v1=s["video"][0]["id"]; a1=s["audio"][0]["id"]
for item,start,dur in ((blue,6.0,4.5),(noir,10.5,4.5),(card,15.0,5.0)):
    m.cmd("timeline.place",item=item,track=v1,time=int(start*T),insert=False,duration=int(dur*T))
m.cmd("timeline.place",item=music,track=a1,time=0,insert=False,video=False)
s=m.tool("sequence_inspect",{})
clips=sorted(s["video"][0]["items"],key=lambda i:i["start"])
print("video clips",[(c["clip"],c["startFrame"],c["durationFrames"]) for c in clips])
for c in clips[1:]:
    print(m.cmd("sequence.applyVideoTransition",clip=c["clip"],effect="cross_dissolve",edge="in",frames=15))
mus=s["audio"][0]["items"]; print("audio",[(c["clip"],c["startFrame"],c["durationFrames"]) for c in mus])
try: print(m.cmd("sequence.applyAudioTransition",clip=mus[0]["clip"],effect="constant_power",edge="out",frames=15))
except Exception as e: print("audio fade err",e)
print(m.cmd("file.saveAs",path=R+"FilmCraft/volterra-x1-promo.fcproj"))
out=R+"FilmCraft/volterra-x1-promo-1080p.mp4"
print(m.tool("command_run",{"id":"file.exportMedia","params":{"path":out,"format":"h264","wait":True}}) if False else m.cmd("file.exportMedia",path=out,format="h264",wait=True))
m.close()
