import json,subprocess,sys
exe=r"C:\Program Files\VectorCraft\vectorcraft-cli.exe"
out=r"E:\ClaudeCraft\CreateCraft_7_App_Integration_Test\VectorCraft"
steps=[]
def c(cmd,**p): steps.append((cmd,p))
c("file.new",name="VOLTERRA X1 Logo (transparent)",width=1200,height=600,units="Pixels")

# lightning bolt symbol
bolt=[(300,70),(180,320),(265,320),(215,530),(390,260),(300,260),(360,70)]
c("path.create",anchors=[{"x":x,"y":y} for x,y in bolt],closed=True); c("paint.setFill",color="#22b8ff"); c("paint.setStroke",color="#bfeaff"); c("stroke.set",weight=3)
# underline accent
c("shape.rectangle",x=450,y=360,width=640,height=6); c("paint.setFill",color="#22b8ff"); c("paint.setStroke",none=True)
c("text.create",x=450,y=300,text="VOLTERRA",size=120,font="Arial",style="Bold",color="#e8f4ff")
c("text.create",x=450,y=470,text="X1",size=110,font="Arial",style="Bold",color="#22b8ff")
c("text.create",x=640,y=450,text="ELECTRIC HYPERCAR",size=36,font="Arial",color="#8fa6bd")
args=[exe,"run"]
for cmd,p in steps: args+=["--cmd",cmd,"--params",json.dumps(p)]
args+=["--export",out+r"\volterra-x1-logo-transparent.svg","--export",out+r"\volterra-x1-logo-transparent.png","--export",out+r"\volterra-x1-logo-transparent.vectorcraft"]
r=subprocess.run(args,capture_output=True,text=True,encoding="utf8")
print(r.returncode); print(r.stdout[-3000:]); print(r.stderr[-1500:])
