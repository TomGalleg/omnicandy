import type { Asset } from '@shared/types';
import { shouldShowTimeline } from '@shared/timeline';

export interface LogEntry {
  at: Date;
  source: string;
  message: string;
}

/** Context-sensitive bottom area: a timeline only for time-based media, otherwise the activity log. */
export function BottomPanel({ selected, log }: { selected: Asset | null; log: LogEntry[] }) {
  const timeline = shouldShowTimeline(selected?.kind);
  return (
    <section className="pane" aria-label={timeline ? 'Timeline' : 'Activity'}>
      <div className="pane-header">
        {timeline ? `Timeline · ${selected!.name}` : 'Activity'}
        {timeline && <span className="asset-meta" style={{ textTransform: 'none', letterSpacing: 0 }}>Read-only preview; editing arrives with SoundCraft/FilmCraft integration</span>}
      </div>
      <div className="pane-body">
        {timeline ? <Timeline asset={selected!} /> : <ActivityLog log={log} />}
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

function Timeline({ asset }: { asset: Asset }) {
  const dur = asset.durationSec ?? 0;
  const ticks = Array.from({ length: 5 }, (_, i) => ((dur * i) / 4).toFixed(2));
  return (
    <div className="timeline">
      <div className="track"><span /><div className="ruler">{ticks.map((t) => <span key={t}>{t}s</span>)}</div></div>
      <div className="track">
        <span>{asset.kind === 'audio' ? 'A1' : 'V1'}</span>
        <div className="clip" title={`${asset.name}, ${dur.toFixed(2)} s`}>
          <svg className="wave" viewBox="0 0 200 20" preserveAspectRatio="none" aria-hidden>
            <path d={Array.from({ length: 100 }, (_, i) => `M${i * 2} ${10 - 7 * Math.abs(Math.sin(i * 0.7))} V${10 + 7 * Math.abs(Math.sin(i * 0.7))}`).join(' ')} stroke="currentColor" strokeOpacity="0.6" />
          </svg>
        </div>
      </div>
      <p className="asset-meta">Waveform is decorative, not decoded from the file. Duration comes from the WAV header.</p>
    </div>
  );
}
