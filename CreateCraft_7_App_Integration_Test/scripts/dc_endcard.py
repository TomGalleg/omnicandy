import json,subprocess,sys
exe=r"C:\Program Files\DesignCraft\designcraft-cli.exe"
R=r"E:\ClaudeCraft\CreateCraft_7_App_Integration_Test"
OUT=R+r"\DesignCraft\volterra-x1-endcard"
HERO=sys.argv[1] if len(sys.argv)>1 else R+r"\LightCraft\volterra-x1-deep-noir.png"
S=[]
def c(cmd,**p): S.extend(["--cmd",f"{cmd}={json.dumps(p)}"])
c("file.new",width=1920,height=1080,title="VOLTERRA X1 end card")
for n,col in (("Volt","#22b8ff"),("Ink","#05070d"),("Ice","#e8f4ff")): c("swatch.create",name=n,color=col)
c("frame.create",rect=[0,0,1920,1080],shape="rectangle",content="graphic"); c("file.place",path=HERO)
c("frame.create",rect=[0,0,1920,320],shape="rectangle",content="unassigned"); c("object.fill",swatch="Ink")
c("frame.create",rect=[660,15,1260,315],shape="rectangle",content="graphic"); c("file.place",path=R+r"\VectorCraft\volterra-x1-logo-transparent.png")
c("frame.create",rect=[160,900,1760,1030],content="text",text="THE FUTURE HAS ARRIVED.")
c("style.paragraph.create",name="EndTag",chars={"fontFamily":"Arial","fontStyle":"Bold","size":78,"fill":"Ice","tracking":60},para={"align":"center"}); c("style.paragraph.apply",name="EndTag")
c("file.saveAs",path=OUT+".designcraft")
args=[exe,"run"]+S+["--export",OUT+".png"]
r=subprocess.run(args,capture_output=True,text=True,encoding="utf8"); print(r.returncode,(r.stdout+r.stderr)[-300:])
