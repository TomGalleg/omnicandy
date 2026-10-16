import { useState } from 'react';
import { PERMISSION_PLAIN, PERMISSION_LEVEL_LABEL } from '@shared/connect';
import { PERMISSION_LABEL, type PackageApproval, type PackageReview, type Permission } from '@shared/integrations';

export const trustLabel = (r: Pick<PackageReview, 'signature' | 'publisherTrusted'>) =>
  r.signature === 'invalid' ? 'Signature invalid' : r.signature === 'unsigned' ? 'Not signed' : r.publisherTrusted ? 'Signed, trusted publisher' : 'Signed, new publisher';
export const trustChip = (r: Pick<PackageReview, 'signature' | 'publisherTrusted'>) => (r.signature === 'valid' && r.publisherTrusted ? 'ok' : 'warn');

interface Props {
  review: PackageReview;
  busy?: boolean;
  /** Button text; defaults to Install / Update. */
  confirmLabel?: string;
  onConfirm(approval: PackageApproval): void;
  onCancel(): void;
  cancelLabel?: string;
  /** Plain-language framing for the guided setup ("Before CreateCraft connects Name…"). */
  intro?: string;
}

/**
 * The review of one connector package: who made it, what it can do, which permissions the user lets it use, and the
 * explicit trust checkboxes. The same card is used by Settings > Integration packages and by the guided setup, so the
 * publisher-trust rules cannot differ between them. Installing stays blocked until the required boxes are ticked.
 */
export function PackageReviewCard({ review, busy, confirmLabel, onConfirm, onCancel, cancelLabel = 'Cancel', intro }: Props) {
  const [granted, setGranted] = useState<Permission[]>(review.permissions);
  const [confirmUnsigned, setConfirmUnsigned] = useState(false);
  const [confirmPublisher, setConfirmPublisher] = useState(false);
  const blocked = review.problems.length > 0
    || (review.signature === 'unsigned' && !confirmUnsigned)
    || (review.signature === 'valid' && !review.publisherTrusted && !confirmPublisher);
  const label = confirmLabel ?? (review.action === 'update' ? 'Update' : 'Install');

  return (
    <div className="ext-row ext-review" role="group" aria-label={`Review connector ${review.name ?? ''}`}>
      <div className="ext-head">
        <strong>{review.name ?? 'Unreadable package'}</strong>
        {review.version && <small>version {review.version}</small>}
        {review.publisherName && <small>by {review.publisherName}</small>}
        <span className={`chip ${trustChip(review)}`}><span className="dot" />{trustLabel(review)}</span>
      </div>
      {intro && <small>{intro}</small>}
      {review.description && <small>{review.description}</small>}
      {review.fingerprint && <small>Publisher key: <code>{review.fingerprint}</code></small>}
      {review.installedVersion && <small>Installed now: version {review.installedVersion}.</small>}
      <small>{review.selfContained ? 'It needs no other program.' : `It controls ${review.applicationName ?? 'a program'} that must already be installed.`}</small>
      {review.requirements.length > 0 && <small className="ext-note">Needs: {review.requirements.map((q) => q.text).join(' · ')}</small>}
      {review.problems.map((p) => <small key={p} className="ext-error" role="alert">{p}</small>)}
      {review.warnings.map((w) => <small key={w} className="ext-note">{w}</small>)}
      {review.commands.length > 0 && (
        <div className="field">
          <span className="menu-label">What it can do</span>
          <ul className="status-list">
            {review.commands.map((c) => (
              <li key={c.id}><small><strong>{c.label}</strong>: {c.description}{c.destructive ? ' (can change existing work; asked every time)' : ''}{c.longRunning ? ' (runs as a background job)' : ''}</small></li>
            ))}
          </ul>
        </div>
      )}
      {review.permissions.length > 0 && (
        <div className="field">
          <span className="menu-label">Permissions it asks for</span>
          {review.permissions.map((p) => (
            <label key={p} className="ext-check">
              <input type="checkbox" checked={granted.includes(p)} onChange={(e) => setGranted((g) => (e.target.checked ? [...g, p] : g.filter((x) => x !== p)))} />
              <span>
                {PERMISSION_PLAIN[p].title} <small>({PERMISSION_LABEL[p]} · {PERMISSION_LEVEL_LABEL[PERMISSION_PLAIN[p].level]})</small>
                <small className="ext-block">{PERMISSION_PLAIN[p].detail}</small>
              </span>
            </label>
          ))}
          <small>Unchecked permissions are refused for good: commands that need them will not run. You are also asked when a command first needs one.</small>
        </div>
      )}
      {review.signature === 'unsigned' && (
        <label className="ext-check"><input type="checkbox" checked={confirmUnsigned} onChange={(e) => setConfirmUnsigned(e.target.checked)} />I understand this package is not signed and will ask me before every command.</label>
      )}
      {review.signature === 'valid' && !review.publisherTrusted && (
        <label className="ext-check"><input type="checkbox" checked={confirmPublisher} onChange={(e) => setConfirmPublisher(e.target.checked)} />I trust {review.publisherName} (key {review.fingerprint}).</label>
      )}
      <div className="ext-actions">
        <button className="btn small primary" disabled={blocked || !!busy} onClick={() => onConfirm({ permissions: granted, allowUnsigned: confirmUnsigned, trustPublisher: confirmPublisher })}>{busy ? 'Installing…' : label}</button>
        <button className="btn small ghost" disabled={!!busy} onClick={onCancel}>{cancelLabel}</button>
      </div>
    </div>
  );
}
