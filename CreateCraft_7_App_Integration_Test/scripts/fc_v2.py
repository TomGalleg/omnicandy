import json,sys
sys.path.insert(0,'_work')
from mcpc import MCP
R="E:/ClaudeCraft/CreateCraft_7_App_Integration_Test/"
m=MCP([r"C:\Program Files\FilmCraft\filmcraft-cli.exe","--data-dir",R+"_work/filmcraft-data","--project",R+"FilmCraft/volterra-x1-promo.fcproj","mcp"])
proj=m.tool("project_inspect",{}) if False else None
try:
    print(json.dumps(m.tool("project_inspect",{}))[:700])
except Exception as e: print("pi",e)
seq=m.tool("sequence_inspect",{}); print("reopened sequence:",seq.get("name"),seq.get("durationFrames"),"frames; video clips",len(seq["video"][0]["items"]),"audio",len(seq["audio"][0]["items"]))
swaps={1:"EffectCraft/volterra-x1-logo-reveal-v2.mp4",2:"LightCraft/volterra-x1-electric-blue-v2.png",4:"DesignCraft/volterra-x1-endcard-v2.png",5:"SoundCraft/volterra-x1-soundtrack-v2.wav"}
for item,p in swaps.items():
    try: print(item,m.cmd("media.replaceFootage",item=item,path=R+p))
    except Exception as e: print("swap",item,"ERR",e)
print(m.cmd("file.saveAs",path=R+"FilmCraft/volterra-x1-promo-v2.fcproj"))
out=R+"FilmCraft/volterra-x1-promo-v2-1080p.mp4"
print(m.cmd("file.exportMedia",path=out,format="h264",wait=True))
m.close()
