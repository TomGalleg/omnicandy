import numpy as np, wave
SR=48000; rng=np.random.default_rng(11)
OUT=r"E:\ClaudeCraft\CreateCraft_7_App_Integration_Test\SoundCraft\stems"
def save(name,x):
    x=np.clip(x,-1,1); 
    if x.ndim==1: x=np.stack([x,x],1)
    pcm=(x*32767).astype('<i2')
    with wave.open(f"{OUT}\{name}.wav","wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
def lp(x,a):  # simple one-pole
    y=np.zeros_like(x); s=0.0
    for i in range(len(x)): s+=a*(x[i]-s); y[i]=s
    return y
def whoosh(dur=1.6):
    n=int(dur*SR); t=np.linspace(0,1,n); noise=rng.standard_normal(n)
    # sweep via modulated cutoff: crude -> mix of band-limited noise copies
    out=np.zeros(n)
    for k,a in enumerate((0.02,0.06,0.15,0.35)):
        out+=lp(noise,a)*np.exp(-((t-(0.3+0.12*k))**2)/0.04)
    env=np.sin(np.pi*t)**1.5
    return out/np.max(np.abs(out))*env*0.8
def riser(dur=2.4):
    n=int(dur*SR); t=np.linspace(0,1,n)
    f=200*(1+10*t**2); ph=2*np.pi*np.cumsum(f)/SR
    s=np.sin(ph)+0.5*np.sin(2*ph)+0.3*rng.standard_normal(n)*t
    return s/np.max(np.abs(s))*t**1.5*0.8
def impact(dur=3.0):
    n=int(dur*SR); t=np.arange(n)/SR
    f=60*np.exp(-t*3)+35; ph=2*np.pi*np.cumsum(f)/SR
    boom=np.sin(ph)*np.exp(-t*1.6)
    burst=lp(rng.standard_normal(n),0.4)*np.exp(-t*7)
    return np.clip((boom*0.9+burst*0.7),-1,1)*0.9
save("fx-whoosh",whoosh()); save("fx-riser",riser()); save("fx-impact",impact())
print("fx ok")
