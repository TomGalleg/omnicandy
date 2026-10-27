import subprocess,json,threading,sys
class MCP:
    def __init__(self,args):
        self.p=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,encoding="utf8",bufsize=1)
        self.i=0
        self.rpc("initialize",{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"it","version":"1"}})
        self.p.stdin.write(json.dumps({"jsonrpc":"2.0","method":"notifications/initialized"})+"\n"); self.p.stdin.flush()
    def rpc(self,m,params):
        self.i+=1; self.p.stdin.write(json.dumps({"jsonrpc":"2.0","id":self.i,"method":m,"params":params})+"\n"); self.p.stdin.flush()
        while True:
            l=self.p.stdout.readline()
            if not l: raise RuntimeError("closed")
            try: d=json.loads(l)
            except: continue
            if d.get("id")==self.i: return d
    def tool(self,name,args=None):
        d=self.rpc("tools/call",{"name":name,"arguments":args or {}})
        if "error" in d: raise RuntimeError(json.dumps(d["error"])[:400])
        r=d["result"]; txt="".join(c.get("text","") for c in r.get("content",[]))
        if r.get("isError"): raise RuntimeError(txt[:600])
        try: return json.loads(txt)
        except: return txt
    def cmd(self,i,**p): return self.tool("command_run",{"id":i,"params":p})
    def close(self):
        try: self.p.stdin.close(); self.p.terminate()
        except: pass
