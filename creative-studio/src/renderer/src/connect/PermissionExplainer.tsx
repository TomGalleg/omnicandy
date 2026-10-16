import { PERMISSION_LEVEL_LABEL, PERMISSION_PLAIN, permissionLine } from '@shared/connect';
import type { CommandSpec, Permission } from '@shared/integrations';

interface Props {
  permissions: Permission[];
  /** Technical details for advanced users (kept behind a disclosure). */
  details?: { adapter?: string | null; version?: string | null; method?: string | null; trust?: string | null; path?: string | null; commands?: CommandSpec[] };
}

/** What a connector may be allowed to do, in plain language, with the technical names one click away. */
export function PermissionExplainer({ permissions, details }: Props) {
  return (
    <div className="perm-explain">
      {permissions.length === 0 ? <small>It only reads basic information. It cannot change anything.</small> : (
        <ul className="perm-list">
          {permissions.map((p) => (
            <li key={p}>
              <span className={`perm-level ${PERMISSION_PLAIN[p].level}`}>{PERMISSION_LEVEL_LABEL[PERMISSION_PLAIN[p].level]}</span>
              <span><strong>{PERMISSION_PLAIN[p].title}.</strong> <small>{PERMISSION_PLAIN[p].detail}</small></span>
            </li>
          ))}
        </ul>
      )}
      {details && (
        <details className="more-details">
          <summary>Technical details</summary>
          <dl className="kv">
            {details.adapter && (<><dt>Connector</dt><dd>{details.adapter}</dd></>)}
            {details.version && (<><dt>Program version</dt><dd>{details.version}</dd></>)}
            {details.method && (<><dt>Control method</dt><dd>{details.method}</dd></>)}
            {details.trust && (<><dt>Trust</dt><dd>{details.trust}</dd></>)}
            {details.path && (<><dt>Location</dt><dd><code>{details.path}</code></dd></>)}
            {permissions.length > 0 && (<><dt>Permissions</dt><dd>{permissions.map(permissionLine).join('; ')}</dd></>)}
            {details.commands && details.commands.length > 0 && (
              <><dt>Commands</dt><dd>{details.commands.map((c) => `${c.id} (${c.permissions.join(', ') || 'none'})${c.destructive ? ' asks every time' : ''}`).join('; ')}</dd></>
            )}
          </dl>
        </details>
      )}
    </div>
  );
}
