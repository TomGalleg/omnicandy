import json,subprocess
exe=r"C:\Program Files\VectorCraft\vectorcraft-cli.exe"
out=r"E:\ClaudeCraft\CreateCraft_7_App_Integration_Test\VectorCraft"
S=[]
def c(cmd,**p): S.append((cmd,p))
def grad(kind,stops,**k): return {"kind":kind,"stops":[{"offset":o,"color":col,**({"opacity":op} if op is not None else {})} for o,col,op in stops],**k}
c("file.new",name="VOLTERRA X1 car illustration",width=1920,height=1080,units="Pixels")
c("shape.rectangle",x=0,y=0,width=1920,height=1080); c("paint.setFill",gradient=grad("linear",[(0,"#02030a",None),(0.7,"#0a1830",None),(1,"#050914",None)])); c("paint.setStroke",none=True)
c("shape.ellipse",x=150,y=770,width=1700,height=120); c("paint.setFill",gradient=grad("radial",[(0,"#1a8fff",0.55),(1,"#1a8fff",0)])); c("paint.setStroke",none=True)
# body
c("path.create",d="M 330 790 L 330 705 C 345 660 430 640 520 628 C 640 560 780 505 960 500 C 1120 498 1230 540 1320 600 C 1420 625 1560 650 1620 700 C 1655 730 1655 765 1645 790 Z")
c("paint.setFill",gradient=grad("linear",[(0,"#cfd9e6",None),(0.35,"#4f6f95",None),(0.7,"#15233a",None),(1,"#070b14",None)])); c("paint.setStroke",color="#7fd0ff"); c("stroke.set",weight=2)
# glasshouse
c("path.create",d="M 640 600 C 720 548 820 522 960 520 C 1090 518 1170 548 1245 600 Z")
c("paint.setFill",gradient=grad("linear",[(0,"#0b2a55",None),(1,"#02060f",None)])); c("paint.setStroke",color="#9bd8ff"); c("stroke.set",weight=1.5)
# accent light line along shoulder
c("path.create",d="M 360 690 C 600 668 1000 660 1300 668 C 1450 672 1560 690 1620 712",closed=False)
c("paint.setFill",none=True); c("paint.setStroke",color="#33c4ff"); c("stroke.set",weight=5)
# headlight + tail light
c("path.create",d="M 1540 676 L 1632 700 L 1636 712 L 1530 690 Z"); c("paint.setFill",color="#e8fbff"); c("paint.setStroke",none=True)
c("shape.rectangle",x=330,y=690,width=14,height=40); c("paint.setFill",color="#ff2a4a"); c("paint.setStroke",none=True)
for cx in (560,1380):
    c("shape.ellipse",x=cx-120,y=790-120,width=240,height=240); c("paint.setFill",color="#03050a"); c("paint.setStroke",none=True)
    c("shape.ellipse",x=cx-98,y=790-98,width=196,height=196); c("paint.setFill",color="#0c0f16"); c("paint.setStroke",color="#222a38"); c("stroke.set",weight=6)
    c("shape.ellipse",x=cx-60,y=790-60,width=120,height=120); c("paint.setFill",gradient=grad("radial",[(0,"#d7f1ff",None),(1,"#2a6fb0",None)])); c("paint.setStroke",color="#bfeaff"); c("stroke.set",weight=3)
    c("shape.ellipse",x=cx-14,y=790-14,width=28,height=28); c("paint.setFill",color="#05070d"); c("paint.setStroke",none=True)
args=[exe,"run"]
for cmd,p in S: args+=["--cmd",cmd,"--params",json.dumps(p)]
args+=["--export",out+r"\volterra-x1-car.svg","--export",out+r"\volterra-x1-car.png","--export",out+r"\volterra-x1-car.vectorcraft"]
r=subprocess.run(args,capture_output=True,text=True,encoding="utf8")
print(r.returncode); print("\n".join(l[:160] for l in r.stdout.splitlines() if 'error' in l.lower() or 'export' in l)); print(r.stderr[-800:])
