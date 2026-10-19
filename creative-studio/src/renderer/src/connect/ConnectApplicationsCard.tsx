import { useRef, useState } from 'react';
import { ConnectWizard } from './ConnectWizard';

/** The prominent entry point at the top of Settings > Integrations. */
export function ConnectApplicationsCard() {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  return (
    <section className="connect-card" aria-labelledby="connect-card-title">
      <div>
        <h3 id="connect-card-title">Connect Applications</h3>
        <p>Find programs like Blender or FreeCAD on this PC and connect them to OmniCandy in a few clicks. OmniCandy explains what each one may do, asks before anything is installed, and tests every connection for real.</p>
      </div>
      <button ref={btn} className="btn primary" onClick={() => setOpen(true)}>Connect Applications…</button>
      {open && <ConnectWizard onClose={() => { setOpen(false); queueMicrotask(() => btn.current?.focus()); }} />}
    </section>
  );
}
