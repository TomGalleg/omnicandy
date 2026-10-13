import { useMemo, useState } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import type { Asset, AssetKind, ProjectManifest } from '@shared/types';
import { formatBytes, formatDims } from '../format';

interface Props {
  manifest: ProjectManifest | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onManifest: (m: ProjectManifest) => void;
  log: (source: string, msg: string) => void;
}

const VIEWABLE: AssetKind[] = ['image', 'vector'];

export function AssetThumb({ asset }: { asset: Asset }) {
  return (
    <div className="thumb">
      {VIEWABLE.includes(asset.kind)
        ? <img src={window.studio.assetUrl(asset.id)} alt="" loading="lazy" draggable={false} />
        : <span>{asset.sourceFormat.toUpperCase()}</span>}
    </div>
  );
}

export function AssetBrowser({ manifest, selectedId, onSelect, onManifest, log }: Props) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | AssetKind>('all');
  const [busy, setBusy] = useState(false);

  const assets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (manifest?.assets ?? []).filter((a) =>
      (kind === 'all' || a.kind === kind) &&
      (!q || a.name.toLowerCase().includes(q) || a.sourceFormat.includes(q) || a.provenance.source.toLowerCase().includes(q)));
  }, [manifest, query, kind]);

  const selected = manifest?.assets.find((a) => a.id === selectedId) ?? null;

  const doImport = async () => {
    setBusy(true);
    try {
      const r = await window.studio.importAssets();
      for (const a of r.imported) log('import', `Imported ${a.name} (sha256 ${a.sha256.slice(0, 12)}…); original copied read-only.`);
      for (const d of r.duplicates) log('import', `${d.name} is an exact duplicate of an existing asset; not copied again.`);
      for (const e of r.errors) log('import', `Error: ${e}`);
      if (r.imported.length || r.duplicates.length) onManifest(await window.studio.loadProject());
      if (r.imported[0]) onSelect(r.imported[0].id);
    } finally {
      setBusy(false);
    }
  };

  const rate = async (rating: number) => {
    if (!selected) return;
    onManifest(await window.studio.setAssetRating(selected.id, rating));
  };

  return (
    <Group orientation="vertical">
      <Panel id="assets" minSize="30">
        <section className="pane" aria-label="Project media">
          <div className="pane-header">
            Media · {manifest?.assets.length ?? 0}
            <button className="btn small" onClick={doImport} disabled={busy}>{busy ? 'Importing…' : 'Import…'}</button>
          </div>
          <div className="asset-tools">
            <input type="search" placeholder="Search name, format, source" aria-label="Search assets" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="all">All</option>
              <option value="image">Images</option>
              <option value="vector">Vector</option>
              <option value="audio">Audio</option>
              <option value="video">Video</option>
              <option value="project">Native docs</option>
            </select>
          </div>
          <div className="pane-body">
            <div className="asset-grid" role="listbox" aria-label="Assets">
              {assets.map((a) => (
                <button key={a.id} role="option" className="asset" aria-selected={a.id === selectedId} onClick={() => onSelect(a.id)}>
                  <AssetThumb asset={a} />
                  <span className="asset-name" title={a.name}>{a.name}</span>
                  <span className="asset-meta">{a.kind} · {formatDims(a) || formatBytes(a.bytes)}</span>
                </button>
              ))}
              {manifest && assets.length === 0 && <p className="asset-meta">No assets match.</p>}
            </div>
          </div>
        </section>
      </Panel>
      <Separator className="sep" />
      <Panel id="inspector" defaultSize="42" minSize={120} collapsible>
        <section className="pane" aria-label="Inspector">
          <div className="pane-header">Inspector</div>
          <div className="pane-body">
            {selected ? (
              <div className="inspector">
                <strong style={{ overflowWrap: 'anywhere' }}>{selected.name}</strong>
                <div className="stars" role="group" aria-label="Rating">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} aria-label={`${n} star${n > 1 ? 's' : ''}`} aria-pressed={(selected.rating ?? 0) >= n} onClick={() => void rate(selected.rating === n ? 0 : n)}>★</button>
                  ))}
                </div>
                <dl className="kv">
                  <dt>Kind</dt><dd>{selected.kind}</dd>
                  <dt>Format</dt><dd>{selected.sourceFormat}</dd>
                  {formatDims(selected) && <><dt>Size</dt><dd>{formatDims(selected)}</dd></>}
                  <dt>Bytes</dt><dd>{formatBytes(selected.bytes)}</dd>
                  <dt>Origin</dt><dd>{selected.provenance.origin}</dd>
                  <dt>Source</dt><dd>{selected.provenance.source}</dd>
                  {selected.provenance.licensingNotes && <><dt>Licensing</dt><dd>{selected.provenance.licensingNotes}</dd></>}
                  <dt>Added</dt><dd>{new Date(selected.provenance.createdAt).toLocaleString()}</dd>
                  <dt>Stored at</dt><dd className="mono">{selected.relPath}</dd>
                  <dt>SHA-256</dt><dd className="mono">{selected.sha256}</dd>
                  <dt>Original</dt><dd>Immutable (read-only copy)</dd>
                </dl>
              </div>
            ) : <p className="inspector asset-meta">Select an asset to inspect it.</p>}
          </div>
        </section>
      </Panel>
    </Group>
  );
}
