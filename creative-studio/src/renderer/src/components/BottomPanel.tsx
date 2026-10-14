import { useEffect, useState } from 'react';
import type { TimelineDto } from '@shared/live';
import type { Asset } from '@shared/types';
import { shouldShowTimeline } from '@shared/timeline';
import type { LiveApi } from '../useLive';

export interface LogEntry {
  at: Date;
  source: string;
  message: string;
}

/** Context-sensitive bottom area: a timeline only for time-based media, otherwise the activity log. */
export function BottomPanel({ selected, log, liveApi }: { selected: Asset | null; log: LogEntry[]; liveApi: LiveApi }) {
  const timeline = shouldShowTimeline(selected?.kind);
  const live = liveApi.live;
  const inFilm = !!selected && live?.appId === 'filmcraft' && live.status === 'ready' && live.asset?.id === selected.id;
  return (
    <section className="pane" aria-label={timeline ? 'Timeline' : 'Activity'}>
      <div className="pane-header">
        {timeline ? `Timeline · ${selected!.name}` : 'Activity'}
        {timeline && (
          <span className="asset-meta" style={{ textTransform: 'none', letterSpacing: 0 }}>
            {inFilm ? 'Live from FilmCraft: click the ruler to move the playhead, a clip to select it' : selected!.kind === 'video' ? 'Open the video in the Edit tab to edit it on FilmCraft\'s timeline' : 'Overview; edit the sound in SoundCraft from the Edit tab'}
          </span>
        )}
      </div>
      <div className="pane-body">
        {timeline ? (inFilm ? <LiveTimeline liveApi={liveApi} /> : <Timeline asset={selected!} />) : <ActivityLog log={log} />}
      </div>
    </section>
  );
}

function ActivityLog({ log }: { log: LogEntry[] }) {
  if (!log.length) return <p className="log">No activity yet.</p>;
  return (
    <div className="log" role="log" aria-live="polite">
      {[...log].reverse().map((e, i) => (
        <div className="log-row" key={log.length - i}>
          <time>{e.at.toLocaleTimeString()}</time>
          <span>{e.source}</span>
          <span>{e.message}</span>
        </div>
      ))}
    </div>
  );
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/** FilmCraft's sequence for the open video, refreshed while it is shown. */
function LiveTimeline({ liveApi }: { liveApi: LiveApi }) {
  const [tl, setTl] = useState<TimelineDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const historyLen = liveApi.live?.history.length ?? 0;
  useEffect(() => {
    let alive = true;
    const load = () => window.studio.live.timeline().then((t) => { if (alive) { setTl(t); setErr(null); } }, (e: unknown) => { if (alive) setErr(String(e)); });
    void load();
    const iv = setInterval(() => void load(), 1500);
    return () => { alive = false; clearInterval(iv); };
  }, [historyLen]);

  if (!tl) return <p className="asset-meta">{err ? 'Could not read the timeline from FilmCraft.' : 'Reading the timeline from FilmCraft…'}</p>;
  const dur = Math.max(tl.duration, 0.1);
  const steps = 5;
  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const s = Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur));
    setTl({ ...tl, playhead: s });
    void window.studio.live.setPlayhead(Math.round(s * 1000) / 1000);
  };
  const select = (id: number) => { setTl({ ...tl, selection: [id] }); void window.studio.live.selectClip(id); };
  const pct = (s: number) => `${(s / dur) * 100}%`;
  let v = 0, a = 0;
  return (
    <div className="timeline live" aria-label="FilmCraft timeline">
      <div className="track">
        <span>{fmt(dur)}</span>
        <div className="ruler seekable" onClick={seek} title="Click to move the playhead" role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={dur} aria-valuenow={tl.playhead ?? 0}>
          {Array.from({ length: steps }, (_, i) => <span key={i}>{fmt((dur * i) / (steps - 1))}</span>)}
        </div>
      </div>
      {tl.tracks.map((t) => (
        <div className="track" key={t.id}>
          <span title={t.name}>{t.kind === 'video' ? `V${++v}` : `A${++a}`}</span>
          <div className="lane" onClick={seek}>
            {t.clips.map((c) => (
              <button key={c.id} className={`tl-clip ${t.kind}${tl.selection.includes(c.id) ? ' selected' : ''}`}
                style={{ left: pct(c.start), width: pct(c.duration) }}
                title={`${c.name} · ${c.duration.toFixed(2)} s${c.speed !== 1 ? ` · ${Math.round(c.speed * 100)}% speed` : ''}${c.effects.length ? `\nEffects: ${c.effects.join(', ')}` : ''}`}
                onClick={(e) => { e.stopPropagation(); select(c.id); }}>
                <span>{c.name}</span>
                {c.effects.filter((x) => !['motion', 'opacity', 'time_remap', 'volume', 'channel_volume', 'panner'].includes(x)).length > 0 && <span className="fx" aria-label="has effects">fx</span>}
              </button>
            ))}
            {t.transitions > 0 && <span className="tl-badge" title="Transitions on this track">{t.transitions} fade{t.transitions === 1 ? '' : 's'}</span>}
            {tl.playhead !== null && <span className="tl-playhead" style={{ left: pct(tl.playhead) }} />}
          </div>
        </div>
      ))}
      <p className="asset-meta">{tl.fps.toFixed(3).replace(/\.?0+$/, '')} fps · edits you make in FilmCraft show up here.</p>
    </div>
  );
}

/** Overview for media that isn't open in a timeline app (length only). */
function Timeline({ asset }: { asset: Asset }) {
  const dur = asset.durationSec ?? 0;
  const ticks = Array.from({ length: 5 }, (_, i) => ((dur * i) / 4).toFixed(2));
  const lanes: Array<'V1' | 'A1'> = asset.kind === 'video' ? ['V1', 'A1'] : ['A1'];
  return (
    <div className="timeline">
      <div className="track"><span /><div className="ruler">{ticks.map((t) => <span key={t}>{t}s</span>)}</div></div>
      {lanes.map((l) => (
        <div className="track" key={l}>
          <span>{l}</span>
          <div className={`clip ${l === 'V1' ? 'video' : ''}`} title={`${asset.name}, ${dur.toFixed(2)} s`}>
            {l === 'A1' && (
              <svg className="wave" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden>
                <path d={Array.from({ length: 100 }, (_, i) => `M${i * 2} ${10 - 7 * Math.abs(Math.sin(i * 0.7))} V${10 + 7 * Math.abs(Math.sin(i * 0.7))}`).join(' ')} stroke="currentColor" strokeOpacity="0.6" />
              </svg>
            )}
            {l === 'V1' && <span className="clip-name">{asset.name}</span>}
          </div>
        </div>
      ))}
      <p className="asset-meta">{asset.kind === 'audio' ? 'The waveform is decorative, not decoded from the file.' : 'Length from the file.'} Duration {dur.toFixed(2)} s.</p>
    </div>
  );
}
