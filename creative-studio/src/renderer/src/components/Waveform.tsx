import { useEffect, useState } from 'react';

const BUCKETS = 400;
const cache = new Map<string, Promise<Float32Array | null>>();

/** Peak per bucket (0..1) of a library file's sound, decoded in the renderer with Web Audio. */
function peaksOf(assetId: string): Promise<Float32Array | null> {
  let p = cache.get(assetId);
  if (!p) {
    p = (async () => {
      try {
        const buf = await (await fetch(window.studio.assetUrl(assetId))).arrayBuffer();
        const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(buf);
        const out = new Float32Array(BUCKETS);
        const per = Math.max(1, Math.floor(audio.length / BUCKETS));
        for (let ch = 0; ch < audio.numberOfChannels; ch++) {
          const d = audio.getChannelData(ch);
          for (let b = 0; b < BUCKETS; b++) {
            let m = 0;
            for (let i = b * per, end = Math.min(d.length, i + per); i < end; i++) { const v = Math.abs(d[i]!); if (v > m) m = v; }
            if (m > out[b]!) out[b] = m;
          }
        }
        return out;
      } catch {
        return null; // no sound track, or a format Chromium can't decode
      }
    })();
    cache.set(assetId, p);
  }
  return p;
}

/** The real waveform of a library file (audio, or a video's sound). `gainDb` scales it like the clip gain. */
export function Waveform({ assetId, gainDb = 0, onState }: { assetId: string; gainDb?: number; onState?: (ok: boolean) => void }) {
  const [peaks, setPeaks] = useState<Float32Array | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void peaksOf(assetId).then((p) => { if (alive) { setPeaks(p); onState?.(!!p); } });
    return () => { alive = false; };
  }, [assetId, onState]);
  if (!peaks) return null;
  const k = Math.pow(10, gainDb / 20);
  const d = Array.from(peaks, (v, i) => { const h = Math.min(1, v * k) * 9.5; return `M${i} ${10 - h} V${10 + Math.max(h, 0.25)}`; }).join(' ');
  return (
    <svg className="wave-real" viewBox={`0 0 ${BUCKETS} 20`} preserveAspectRatio="none" aria-hidden data-wave="real">
      <path d={d} stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
