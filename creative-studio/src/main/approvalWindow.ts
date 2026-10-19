// A styled, always-visible approval dialog (replaces the plain native message box for paid generation).
// It is a small modal window with an inline page; the answer comes back through the page title, so it
// needs no preload and no extra IPC.
import { BrowserWindow } from 'electron';

export interface ApprovalCard {
  title: string;
  heading: string;
  /** Big highlighted line (a price). Omit for non-paid approvals. */
  cost?: string;
  costNote?: string;
  /** Short intro paragraph under the heading. */
  intro?: string;
  /** A command or script shown in a monospace box. */
  code?: string;
  /** Accent colour: green for money, amber for actions that reach outside the picture. */
  tone?: 'cost' | 'warn';
  rows: Array<[string, string]>;
  footnote?: string;
  confirmLabel: string;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function html(c: ApprovalCard): string {
  const rows = c.rows.filter(([, v]) => v).map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;cursor:default}
html,body{margin:0;height:100%;background:#16181d;color:#e9ebf0;font:14px/1.45 "Segoe UI",system-ui,sans-serif;user-select:none}
body{display:flex;flex-direction:column;padding:22px 24px 20px}
h1{font-size:16px;font-weight:600;margin:0 0 14px}
.cost{background:#1f2430;border:1px solid #2f3748;border-radius:10px;padding:12px 14px;margin-bottom:14px}
.cost .amt{font-size:26px;font-weight:700;color:#7fd1a0}
.ic{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:#f0b429;color:#16181d;font-weight:800;font-size:14px;margin-right:10px;vertical-align:1px}
.intro{margin:-6px 0 12px;color:#b4bccc}
.code{margin:0 0 12px;max-height:150px;overflow:auto;background:#0f1115;border:1px solid #2a3040;border-radius:8px;padding:10px 12px;font:12px/1.5 Consolas,monospace;color:#c9d4ea;white-space:pre-wrap;word-break:break-all;user-select:text}
.cost .note{font-size:12px;color:#9aa3b5;margin-top:2px}
.rows{flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px}
.row{display:flex;gap:12px}.k{flex:0 0 78px;color:#8a93a6;font-size:12px;padding-top:1px}.v{flex:1;word-break:break-word;user-select:text}
.foot{font-size:12px;color:#9aa3b5;margin:12px 0 14px}
.btns{display:flex;justify-content:flex-end;gap:10px}
button{font:inherit;border-radius:8px;padding:8px 18px;border:1px solid #3a4256;background:#232938;color:#e9ebf0;cursor:pointer}
button:hover{background:#2b3245}button.go{background:#2f7cf6;border-color:#2f7cf6;color:#fff;font-weight:600}button.go:hover{background:#4690ff}
button:focus-visible{outline:2px solid #8fb8ff;outline-offset:2px}
</style></head><body>
<h1>${c.tone === 'warn' ? '<span class="ic">!</span>' : ''}${esc(c.heading)}</h1>
${c.intro ? `<p class="intro">${esc(c.intro)}</p>` : ''}${c.cost ? `<div class="cost"><div class="amt">${esc(c.cost)}</div>${c.costNote ? `<div class="note">${esc(c.costNote)}</div>` : ''}</div>` : ''}${c.code ? `<pre class="code">${esc(c.code)}</pre>` : ''}
<div class="rows">${rows}</div>
${c.footnote ? `<div class="foot">${esc(c.footnote)}</div>` : ''}
<div class="btns"><button id="n" autofocus>Cancel</button><button id="y" class="go">${esc(c.confirmLabel)}</button></div>
<script>
const done=(v)=>{document.title='RESULT:'+v};
document.getElementById('y').onclick=()=>done('yes');
document.getElementById('n').onclick=()=>done('no');
addEventListener('keydown',(e)=>{if(e.key==='Escape')done('no')});
</script></body></html>`;
}

/** Resolves true only when the user clicks the confirm button. Closing the window cancels. */
export function showApprovalCard(parent: BrowserWindow | null | undefined, card: ApprovalCard): Promise<boolean> {
  return new Promise((resolve) => {
    const usable = parent && !parent.isDestroyed() ? parent : undefined;
    const win = new BrowserWindow({
      width: 520, height: card.code ? 500 : 520, minWidth: 420, minHeight: 340,
      show: false, alwaysOnTop: true, center: true, title: card.title,
      autoHideMenuBar: true, minimizable: false, maximizable: false, backgroundColor: '#16181d',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.removeMenu();
    win.setAlwaysOnTop(true, 'screen-saver');
    if (usable) { const b = usable.getBounds(); const [w = 520, h = 520] = win.getSize(); win.setPosition(Math.round(b.x + (b.width - w) / 2), Math.round(b.y + (b.height - h) / 2)); }
    let settled = false;
    const finish = (ok: boolean): void => { if (settled) return; settled = true; resolve(ok); if (!win.isDestroyed()) win.close(); };
    win.on('page-title-updated', (e, t) => { if (t.startsWith('RESULT:')) { e.preventDefault(); finish(t === 'RESULT:yes'); } });
    win.on('closed', () => finish(false));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.once('ready-to-show', () => { win.show(); win.moveTop(); win.focus(); });
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html(card))}`);
  });
}
