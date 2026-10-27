import json,subprocess,sys
exe=r"C:\Program Files\DesignCraft\designcraft-cli.exe"
R=r"E:\ClaudeCraft\CreateCraft_7_App_Integration_Test"
HERO=sys.argv[1] if len(sys.argv)>1 else R+r"\PhotoCraft\volterra-x1-car-edited.png"
OUT=sys.argv[2] if len(sys.argv)>2 else R+r"\DesignCraft\volterra-x1-poster"
S=[]
def c(cmd,**p): S.extend(["--cmd",f"{cmd}={json.dumps(p)}"])
c("file.new",width=1080,height=1620,title="VOLTERRA X1 poster")
for n,col in (("Volt","#22b8ff"),("Ink","#05070d"),("Ice","#e8f4ff"),("Steel","#8fa6bd")): c("swatch.create",name=n,color=col)
c("frame.create",rect=[0,0,1080,1620],shape="rectangle",content="unassigned"); c("object.fill",swatch="Ink")
c("frame.create",rect=[0,430,1080,1037],shape="rectangle",content="graphic"); c("file.place",path=HERO)
c("frame.create",rect=[250,70,830,360],shape="rectangle",content="graphic"); c("file.place",path=R+r"\VectorCraft\volterra-x1-logo-transparent.png")
c("frame.create",rect=[30,1110,1050,1250],content="text",text="THE FUTURE HAS ARRIVED."); c("style.paragraph.create",name="Tagline",chars={"fontFamily":"Arial","fontStyle":"Bold","size":64,"fill":"Ice"},para={"align":"center"}); c("style.paragraph.apply",name="Tagline")
c("frame.create",rect=[60,1330,1020,1400],content="text",text="VOLTERRA X1  |  ALL-ELECTRIC HYPERCAR"); c("style.paragraph.create",name="Sub",chars={"fontFamily":"Arial","size":32,"fill":"Volt","tracking":200},para={"align":"center"}); c("style.paragraph.apply",name="Sub")
c("frame.create",rect=[60,1520,1020,1570],content="text",text="Fictional vehicle. Created by Claude with CreateCraft and ArtCraft apps."); c("style.paragraph.create",name="Fine",chars={"fontFamily":"Arial","size":20,"fill":"Steel"},para={"align":"center"}); c("style.paragraph.apply",name="Fine")
c("file.saveAs",path=OUT+".designcraft")
args=[exe,"run"]+S+["--export",OUT+".pdf","--scale","1","--export",OUT+".png"]
r=subprocess.run(args,capture_output=True,text=True,encoding="utf8")
print(r.returncode); print("\n".join(l[:200] for l in (r.stdout+r.stderr).splitlines()[-25:]))
# editable save via script mode
