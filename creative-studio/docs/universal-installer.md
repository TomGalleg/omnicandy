# Universal Installer and plugin bridge

One architecture for every kind of external-program integration. It extends the Universal Connect framework
(`docs/external-integration-sdk.md`); it does not replace it, and it never touches the 13 native Craft apps.

| Type | What is installed | Who does the work | Example |
|---|---|---|---|
| `external` | A connector (adapter process inside CreateCraft, restricted) | The connector drives the program from outside (CLI, files, COM...) | Blender, FreeCAD, Resolve |
| `internal` | An add-in inside the program. **No connector code runs in CreateCraft** | The add-in, over the bridge | SimCAD add-in sample |
| `hybrid` | Both. They are installed, repaired and removed together | The connector orchestrates and verifies; the add-in does what only code inside the program can do | SimCAD hybrid sample |

Autodesk and Adobe are **not** special cases: they are rows in the same host-profile table
(`src/main/integrations/install/hostProfiles.ts`, documented in `docs/installation-profiles.md`). Only Revit 2027 is marked `supported`
(it has a real, live-tested add-in); every other row is still groundwork.

## Pieces

```
Connect Applications (wizard)  ->  AdapterPackages (loader.ts)  = Universal Installation Manager
                                      |-- PackageStore       verified package on disk, trust, saved original for Repair
                                      |-- PluginInstaller    in-program files: plan, approved destinations, ledger, rollback
                                      |-- BridgeServer       authenticated local pipe to add-ins
                                      '-- IntegrationManager permissions, jobs, timeouts, verification (unchanged)
```

### 1. Manifest version 2 (`adapter.json`)

`manifestVersion` 1 packages (external only) are read unchanged. Version 2 adds an optional `integration` block and makes `runtime`
optional (internal-only packages carry no adapter code).

```jsonc
"integration": {
  "type": "hybrid",                       // external | internal | hybrid
  "host":   { "profile": "simcad", "simulated": true, "editions": ["Pro","Lite"], "versions": [{ "min": "1.0", "max": "1.9" }] },
  "plugin": {
    "id": "simcad.bridge.hybrid", "version": "1.0.0", "technology": "node-module",
    "mechanism": "file-copy",             // or "vendor-workflow": CreateCraft only guides
    "destination": "simcad-plugins",      // an id from the INSTALLER's table, not a path
    "files": [{ "from": "plugin/x.plugin.js", "to": "x.plugin.js" }],
    "restart": "required", "closeHost": "required", "admin": "never",
    "dependencies": [], "vendorWorkflow": { "title": "...", "steps": ["..."], "officialUrl": "https://..." }
  },
  "communication": { "transport": "named-pipe", "protocol": { "min": 1, "max": 1 },
    "capabilities": [{ "id": "scene.describe", "permissions": ["read-project"] }] },
  "uninstall": { "vendorWorkflow": { "title": "...", "steps": ["..."] } }
}
```

Covers: supported application names, versions and editions; target plugin folder (by id); restart, close and administrator
requirements; dependencies and runtimes; vendor-supported installation mechanisms; the communication endpoint and the
capabilities the add-in may ever register; uninstall/repair (derived from the ledger, plus an optional vendor uninstall guide).

Deliberately **absent**: scripts, command lines, absolute paths, registry keys, "post-install" hooks. The schema is `strict`, so any
such field is rejected as unrecognised. A manifest cannot grant itself filesystem or system access: it names a destination and the
installer decides whether that destination exists, what it resolves to, which file types it takes and whether it needs
administrator rights. The permissions its capabilities need are added to what the user reviews, and the manager refuses anything the
user did not approve, exactly as for connectors.

### 2. Universal Installation Manager

`AdapterPackages.review()` returns the normal package review plus an `integration` plan: the steps the person will see (close the
program, install the connector, install the add-in, administrator access, open or restart the program, allow it inside the program,
test), blockers, the exact folders, and everything technical for the Advanced section.

`AdapterPackages.install()` order (hybrid):

1. Re-read the package, re-check hashes/signature/permissions (nothing from the screen is trusted).
2. Plan the add-in install. Permanent problems (unknown destination, wrong file type, path escape, ...) block the package;
   transient blockers (the program is open and must be closed) stop the install with a plain message and a **Check again** button.
   CreateCraft never closes the program.
3. **Add-in files first** (`PluginInstaller.install`), because they have their own undo. Then the package (`PackageStore.install`) and
   registration. If the second half fails after the first succeeded, the add-in is taken out again (fresh install) so nothing is
   left half-installed. An interrupted install is rolled back at the next start (`recover()`).
4. Nothing is reported as connected. Connected requires a real round trip (below).

**PluginInstaller rules** (`install/pluginInstaller.ts`, tested in `install/installer.test.ts`):

- the only operation is *write a verified file into an approved folder*; no script of the package ever runs;
- destinations, scopes, extensions, size and file-count limits come from `hostProfiles.ts`, re-checked at install time;
- the installer-owned pairing file `cc-bridge.json` (random 256-bit secret) is added to every plugin install; the same secret is
  stored under `<userData>/integrations/bridge/pairing/<pluginId>.json`;
- a journal (`ledger.json`) is written before each change; backups of replaced files; rollback on error, cancel or crash;
- existing files CreateCraft did not install are never overwritten; uninstall removes only files whose hash still matches what was
  installed (user-edited files are kept and reported) and the folders it created;
- **verify** compares disk with the ledger (`installed`, `restart-needed`, `modified`, `missing-files`); **repair** reinstalls from the
  verified saved original (`source-<version>.ccadapter`), never from the possibly damaged installed copy;
- temporary files use the extension `.ccpart`, which no host loads.

**Administrator rights.** A destination that needs administrator rights is written only when (a) the manifest says so (it cannot
claim otherwise), (b) the user's native confirmation covered it, and (c) an `Elevator` is available. This build ships **no elevator**:
`elevate` is not accepted from the screen, and the installer stops with "run the vendor's own installer or use the per-user folder".
The path is implemented and unit-tested with a fake elevator; a real UAC helper needs its own security review.

**Vendor workflows.** For technologies the vendor installs itself (for example Adobe UXP through Creative Cloud) the manifest uses
`mechanism: "vendor-workflow"`; CreateCraft shows the steps, creates the pairing secret, copies nothing, and the integration becomes
Connected only when the add-in actually connects.

### 3. Plugin bridge (`bridge/`)

Transport: a Windows **named pipe** (Unix socket elsewhere) created by CreateCraft with a random name per run, announced in
`<userData>/integrations/bridge/endpoint.json`. Chosen because it is local by construction (the OS rejects remote clients on these
pipes), needs no port, firewall rule or HTTP stack, and every host technology that can open a file or pipe can use it. No TCP/HTTP
endpoint is opened. Newline-delimited JSON, frames at most 1 MB.

Roles: CreateCraft is the server and the only side that issues work. The plugin dials in, so it can run inside the program's own
context and survive CreateCraft restarts by reconnecting. **Protocol version 1:**

| Frame | Direction | Purpose |
|---|---|---|
| `hello` | both | server: nonce + supported protocol range. plugin: `pluginId`, version, app `{name, version, edition, pid}`, its range, client nonce and `proof = HMAC-SHA256(secret, "cc-bridge\|c\|snonce\|cnonce\|pluginId\|min-max")` |
| `welcome` / `reject` | server | negotiated version (highest common), `proof` for the server (mutual auth), session id, heartbeat; or a reason (`auth-failed`, `protocol-mismatch`, `malformed`, `too-slow`, `replaced`) |
| `register` | plugin | capability ids available in *this* program/edition right now. Only ids the installed manifest allows are accepted; the rest are listed as refused |
| `health` / `command` | server | health check, or a typed command `{id, name, params, timeoutMs}` (params already validated against the manifest's typed spec) |
| `progress` | plugin | stage and fraction while a command runs |
| `result` | plugin | `{ok, message, data(≤64 KB), evidence[], verified, error{kind,message}}` |
| `cancel` | server | stop a running command |
| `ping` / `pong` | both | heartbeat; a silent plugin is dropped after three intervals |

Authentication: the secret is never sent; the proof binds both nonces, the plugin id and the offered range, so it cannot be replayed
on another connection; the plugin checks the server's proof too, so a fake server cannot collect commands. An unknown plugin and a
wrong secret get the **same** answer. Frames before `hello`, non-JSON, oversized or unknown frames close the connection. A plugin
that connects again replaces its earlier session. Disable/uninstall disconnects the session and removes its allow-list entry.

Execution context: a command is only a request. The plugin library (`src/plugin-sdk/ccbridge-client.js`, and the same frames in
C#, Python or CEP/UXP) **requires an `executor`** that runs the handler inside the host's supported API context (Revit
`ExternalEvent`, a main-thread dispatcher, ...). The sample's simulated program throws if its API is touched anywhere else, and the
sample plugin works because it goes through the executor.

Timeouts, cancellation, loss: each call has a timeout (on expiry the plugin is sent `cancel`); the manager's cancel/job-cancel sends
`cancel` and waits a short grace period; if the connection drops during a command the call fails as **`connection-lost` (outcome
unknown: the command may have run)**, never as success; the plugin reconnects by itself with backoff and re-reads the endpoint file,
so an application restart or a CreateCraft restart recovers without user action.

Dynamic capabilities: the manifest lists the **maximum** set (with permissions); the plugin registers what its program/edition can
actually do. The manager refuses commands the plugin did not register ("the add-in has not made X available (this edition...)").
The plugin cannot add commands that are not in the manifest, because permissions must be reviewable before install.

Hybrid: the connector reaches the add-in only through `ctx.plugin.call(name, params)`, a host operation that checks the capability
is declared and that the command in flight has the permissions that capability declares. A hybrid integration's health check requires
**both** halves; the add-in must answer a real check from inside the program.

### 4. Connection truth

"Connected" and "Tested" are shown only after `manager.connect()` and `manager.verify()` succeeded, and for add-ins that means a
`health` round trip answered from inside the program. Installed-but-not-loaded shows "Open the program, or restart it so it loads the
add-in". Closing the program drops the session immediately; the next command fails honestly.

### 5. Universal Connect experience

Find installed applications, pick one, see which connector (and add-in) is needed, review permissions and folders, install
(native confirmation names the publisher, permissions, folder, close/restart steps), test, get a clear success or an actionable
error. Technical detail (paths, technology, protocol, capabilities, dependencies) sits under **Advanced**. Connectors that bring
their own program (self-contained, e.g. the simulated SimCAD) are offered directly in the list.

## Security statement

What is enforced: strict manifest schema; no scripts; approved destinations/extensions/limits owned by CreateCraft; hash and signature
checks (unchanged); journalled, reversible installs; no overwrite of foreign files; the program is never closed; elevation needs
user approval and an elevator; authenticated, mutual, nonce-bound local pipe; typed, validated parameters (data, never concatenated
into a shell or script); capability allow-list; result size limits; main-process decisions, not the renderer's, for plugin install.

What is **not** provided (unchanged and new):

- Adapter process isolation is still not a complete OS sandbox: Node's permission model does not restrict network access, and the
  adapter runs as the same Windows user.
- The pairing secret is protected by the user's profile permissions. Another process of the *same user* (or malware running as
  that user) can read it and talk to the bridge. Different users and remote machines cannot. Binding the secret to the add-in
  process identity needs OS APIs not used here.
- The plugin code itself runs inside the other program with that program's privileges. CreateCraft verifies the files it installs but
  cannot sandbox what a signed add-in does inside Revit or Photoshop.
- A running host that already loaded an add-in keeps it until restarted; uninstall disconnects the session but cannot unload code.
- No network isolation for adapters, no revocation feed, no production signing key (see `docs/release-signing.md`).

## What is proven, and what is simulated

Proven with real parts in tests (`install/installer.test.ts`, `bridge/bridge.test.ts`, `hybrid.test.ts`, `release.test.ts`,
`scripts/smoke-connect-hybrid.mjs`): file install/verify/repair/uninstall, rollback and crash recovery, the named pipe with real
processes, a real child process playing SimCAD that loads the installed add-in at start-up and enforces its API-context rule, a real
command through the companion with an independent verification, cancellation, reconnect after application restart, edition-based
capability registration, permission refusal, unauthenticated-peer refusal, uninstall, and the whole flow in the real app window
(and in the packaged, unpacked application).

**Simulated:** SimCAD itself (`fixtures/simcad`), clearly labelled in the review, in the connector list and in the package manifest
(`host.simulated: true`); simulated packages and the test application are excluded from release builds by `release-check`.
**Real, live-tested:** the Autodesk Revit 2027 add-in (`docs/revit-integration.md`), run against the installed Revit 2027 on the development PC.
**Not built:** every other Autodesk and Adobe add-in. Their profiles are documentation and installer rules only.
