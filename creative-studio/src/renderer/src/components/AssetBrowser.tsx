import { useEffect, useMemo, useState } from 'react';
import { COLLECTIONS, collectionCounts, inCollection, type CollectionId } from '@shared/collections';
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels';
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

/** Plain names for asset kinds, as people say them. */
export const KIND_LABEL: Record<AssetKind, string> = { image: 'Picture', vector: 'Vector art', audio: 'Sound', video: 'Video', project: 'App document', design: 'Layout', document: 'Document', sheet: 'Spreadsheet', deck: 'Presentation', ui: 'UI design', cad: 'CAD drawing' };
const ORIGIN_LABEL: Record<string, string> = { imported: 'Imported', generated: 'Created in OmniCandi', fixture: 'Sample file' };

const readKey = (k: string) => { try { return window.localStorage.getItem(k); } catch { return null; } };
const writeKey = (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* storage unavailable */ } };

export function AssetThumb({ asset, rendition }: { asset: Asset; rendition?: Asset }) {
  const shown = VIEWABLE.includes(asset.kind) ? asset : rendition;
  return (
    <div className="thumb">
      {shown
        ? <img src={window.studio.assetUrl(shown.id)} alt="" loading="lazy" draggable={false} />
        : asset.kind === 'video'
          ? <video src={`${window.studio.assetUrl(asset.id)}#t=1`} muted preload="metadata" aria-hidden tabIndex={-1} />
          : <span>{asset.sourceFormat.toUpperCase()}</span>}
    </div>
  );
}

export function AssetBrowser({ manifest, selectedId, onSelect, onManifest, log }: Props) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | AssetKind>('all');
  const [collection, setCollection] = useState<CollectionId>('all');
  const [exportsList, setExports] = useState<Array<{ name: string; bytes: number; modified: string }>>([]);
  useEffect(() => { void window.studio.listExports().then(setExports).catch(() => setExports([])); }, [manifest?.updatedAt]);
  const [busy, setBusy] = useState(false);
  // The details panel under the grid can be folded down to its header; remembered.
  const detailsRef = usePanelRef();
  const [detailsOpen, setDetailsOpen] = useState(() => readKey('cs-details-open') !== '0');
  useEffect(() => {
    const p = detailsRef.current;
    if (!p) return;
    if (detailsOpen && p.isCollapsed()) p.expand();
    if (!detailsOpen && !p.isCollapsed()) p.collapse();
    writeKey('cs-details-open', detailsOpen ? '1' : '0');
  }, [detailsOpen, detailsRef]);

  const assets = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (manifest?.assets ?? []).filter((a) =>
      inCollection(a, collection) &&
      (kind === 'all' || a.kind === kind) &&
      (!q || a.name.toLowerCase().includes(q) || a.sourceFormat.includes(q) || a.provenance.source.toLowerCase().includes(q)));
  }, [manifest, query, kind, collection]);
  const counts = useMemo(() => collectionCounts(manifest?.assets ?? [], exportsList.length), [manifest, exportsList]);

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
            <select aria-label="Collection" title={COLLECTIONS.find((c) => c.id === collection)?.hint} value={collection} onChange={(e) => setCollection(e.target.value as CollectionId)}>
              {COLLECTIONS.map((c) => <option key={c.id} value={c.id}>{c.label} ({counts[c.id]})</option>)}
            </select>
            <input type="search" placeholder="Search files" aria-label="Search files" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select aria-label="Filter by kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="all">All</option>
              <option value="image">Pictures</option>
              <option value="vector">Vector art</option>
              <option value="audio">Sounds</option>
              <option value="video">Videos</option>
              <option value="design">Layouts</option>
              <option value="document">Documents</option>
              <option value="sheet">Spreadsheets</option>
              <option value="deck">Presentations</option>
              <option value="ui">UI designs</option>
              <option value="cad">CAD drawings</option>
              <option value="project">App documents</option>
            </select>
          </div>
          <div className="pane-body">
            <div className="asset-grid" role="listbox" aria-label="Assets">
              {collection === 'deliverables' && (
                <div className="asset-meta" style={{ gridColumn: '1 / -1' }}>
                  {exportsList.length === 0 ? 'Nothing exported yet. Use the Deliver tab.' : exportsList.map((e) => (
                    <div key={e.name}><button className="btn small ghost" onClick={() => void window.studio.revealExport(e.name)}>{e.name}</button> {formatBytes(e.bytes)}</div>
                  ))}
                </div>
              )}
              {collection !== 'deliverables' && assets.map((a) => (
                <button key={a.id} role="option" className="asset" aria-selected={a.id === selectedId} onClick={() => onSelect(a.id)}>
                  <AssetThumb asset={a} rendition={a.sourceFormat === 'pcraft' || a.sourceFormat === 'designcraft' || ['docx', 'pdf', 'xlsx', 'deckcraft', 'pptx', 'figcraft', 'dxf', 'dwg'].includes(a.sourceFormat) ? manifest?.assets.find((x) => x.parentId === a.id && x.kind === 'image') : undefined} />
                  <span className="asset-name" title={a.name}>{a.name}</span>
                  <span className="asset-meta">{KIND_LABEL[a.kind]} · {formatDims(a) || formatBytes(a.bytes)}</span>
                </button>
              ))}
              {manifest && collection !== 'deliverables' && assets.length === 0 && <p className="asset-meta">No files match.</p>}
            </div>
          </div>
        </section>
      </Panel>
      <Separator className="sep" />
      <Panel id="inspector" defaultSize="38" minSize={120} collapsible collapsedSize={36} panelRef={detailsRef}
        onResize={() => { const c = detailsRef.current?.isCollapsed() ?? false; if (c === detailsOpen) setDetailsOpen(!c); }}>
        <section className="pane" aria-label="Inspector">
          <div className="pane-header">
            Details
            <button className="btn small ghost" aria-expanded={detailsOpen} aria-controls="asset-details" onClick={() => setDetailsOpen((o) => !o)}
              title={detailsOpen ? 'Hide file details' : 'Show file details'}>{detailsOpen ? 'Hide' : 'Show'}</button>
          </div>
          <div className="pane-body" id="asset-details" hidden={!detailsOpen}>
            {selected ? (
              <div className="inspector">
                <strong style={{ overflowWrap: 'anywhere' }}>{selected.name}</strong>
                <div className="stars" role="group" aria-label="Rating">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} aria-label={`${n} star${n > 1 ? 's' : ''}`} aria-pressed={(selected.rating ?? 0) >= n} onClick={() => void rate(selected.rating === n ? 0 : n)}>★</button>
                  ))}
                </div>
                <dl className="kv">
                  <dt>Type</dt><dd>{KIND_LABEL[selected.kind]} ({selected.sourceFormat.toUpperCase()})</dd>
                  {formatDims(selected) && <><dt>Size</dt><dd>{formatDims(selected)}</dd></>}
                  <dt>File size</dt><dd>{formatBytes(selected.bytes)}</dd>
                  {selected.parentId && (() => {
                    const parent = manifest?.assets.find((a) => a.id === selected.parentId);
                    return <><dt>Derived from</dt><dd>{parent ? <button className="btn small ghost" style={{ padding: 0, height: 'auto' }} onClick={() => onSelect(parent.id)}>{parent.name}</button> : 'missing'}</dd></>;
                  })()}
                  {selected.provenance.prompt && <><dt>Prompt</dt><dd>{selected.provenance.prompt}</dd></>}
                  <dt>Added</dt><dd>{new Date(selected.provenance.createdAt).toLocaleString()}</dd>
                </dl>
                <details className="more-details">
                  <summary>More details</summary>
                  <dl className="kv">
                    <dt>Origin</dt><dd>{ORIGIN_LABEL[selected.provenance.origin] ?? selected.provenance.origin}</dd>
                    <dt>Source</dt><dd>{selected.provenance.source}</dd>
                    {selected.provenance.settings && <><dt>Settings</dt><dd>{Object.entries(selected.provenance.settings).map(([k, v]) => `${k}: ${v}`).join(', ')}</dd></>}
                    {selected.provenance.estimatedCostUsd !== undefined && selected.provenance.estimatedCostUsd > 0 && <><dt>Est. cost</dt><dd>${selected.provenance.estimatedCostUsd.toFixed(4)} for the request (approved{selected.provenance.requestedBy === 'claude' ? ', asked by Claude' : ''})</dd></>}
                    {selected.provenance.referenceAssetIds?.length ? <><dt>References</dt><dd>{selected.provenance.referenceAssetIds.map((id) => manifest?.assets.find((a) => a.id === id)?.name ?? 'missing').join(', ')}</dd></> : null}
                    {selected.provenance.licensingNotes && <><dt>Licensing</dt><dd>{selected.provenance.licensingNotes}</dd></>}
                    <dt>Stored at</dt><dd className="mono">{selected.relPath}</dd>
                    <dt>Checksum</dt><dd className="mono" title="SHA-256">{selected.sha256}</dd>
                    <dt>{selected.parentId ? 'Version' : 'Original'}</dt><dd>Never changed; edits create new versions</dd>
                  </dl>
                </details>
              </div>
            ) : <p className="inspector asset-meta">Select a file to see its details.</p>}
          </div>
        </section>
      </Panel>
    </Group>
  );
}
