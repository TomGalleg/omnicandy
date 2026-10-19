# Release signing and key management

Three different things get signed or trusted. They must not be confused.

| What | Signed by | Verified by | Where the key lives |
|---|---|---|---|
| **Connector / add-in packages** (`.ccadapter`) | Ed25519 key (the *publisher key*) | OmniCandy, on review, install, every start-up and Repair | Release owner's secure store (never in the repository) |
| **The installer and `OmniCandy.exe`** | The organisation's Authenticode code-signing certificate | Windows (SmartScreen, UAC) | Certificate store / HSM / signing service |
| **Update channel (future)** | Not built yet | n/a | n/a |

## The development key is not an identity

`scripts/build-catalog.mjs` (no flags) generates `.local/createcraft-integrations.key.pem` on first run. That key exists so
developers can exercise signing end to end. It is **not** a publisher identity:

- it is generated on a developer machine, is never backed up and has no owner;
- `.local/` is not committed;
- `scripts/release-check.mjs` refuses to release any build signed by a key that is not listed in
  `resources/trust/release-publishers.json`, and that list is **empty today** because no production key exists yet;
- the installer config bundles `resources/adapters/*.ccadapter` only. The key, `.local/` and `fixtures/` are never packaged.

A user who installs a development-signed connector is shown "Signed, new publisher" with the fingerprint and must tick *I trust
this publisher* (existing behaviour), exactly as for any third party.

## Producing a release key (release owner, once)

1. On a trusted, offline or HSM-backed machine: `node scripts/pack-adapter.mjs --generate-key <path>` (Ed25519, PKCS#8 PEM), or
   generate it in the HSM and export only the public key.
2. Store the private key in the organisation's secret store with at least two named custodians and an offline backup. Never put it
   in the repository, CI logs, or a developer laptop's working folder.
3. Record its fingerprint (printed by the build) in `resources/trust/release-publishers.json` through a reviewed change:
   `{ "publishers": [{ "name": "OmniCandy Integrations", "fingerprint": "ABCD EF01 …" }] }` (8 groups of 4 hex characters).
   Listing a fingerprint tells OmniCandy to treat packages signed by that key as from a trusted publisher *without* the new-publisher
   checkbox. Review it like a security change.

## Producing a release

```
node scripts/build-catalog.mjs --release <release-key.pem>   # signs the official connectors with the release key
node scripts/release-check.mjs resources                     # must print RELEASABLE
npm run dist                                                 # release-check + electron-builder (NSIS installer)
```

`release-check` fails the build when: a bundled package has a wrong hash or an invalid/missing signature; its key is not in the
release list; a private key file (`*.pem`, `*.key`, `*.pfx`), `.local`, `fixtures` or the simulated test application is present;
a sample or simulated-application connector is bundled; or any Autodesk/Adobe program or library is present. `--allow-dev` turns the
key check into a warning for local test builds; the result is then reported as **NOT RELEASABLE**.

Then sign the installer and `OmniCandy.exe` with the organisation's code-signing certificate (set `win.signAndEditExecutable`
and the certificate variables in CI; not configured here because no certificate exists).

## Independent updates

Official connectors are separate packages with their own version. Installing a newer version of a connector (from the inbox, from a
later installer, or from a future update feed) goes through the same review: same publisher key required, older versions refused,
the previous version removed only after the new one is registered. The application does not need to be rebuilt to ship a connector
fix. The bundled catalog is only the first install.

## Rotation and revocation

- **Rotate:** build with the new key, add the new fingerprint, ship; keep the old fingerprint listed until installed connectors have
  been updated, then remove it in a later release. A package already installed from the old key keeps working until updated; an
  update must be signed by the same key (identity change is blocked by the store, uninstall first).
- **Revoke:** remove the fingerprint from `release-publishers.json` in a release. Installed packages stay verified against the key
  the user approved at install, so a compromised key additionally needs a "turn off integration" notice (not built yet; listed under
  limitations).

## Limits to be honest about

- No production key or code-signing certificate exists in this repository.
- There is no update feed or revocation list yet.
- The Windows installer was built and unpacked for testing; it was not signed.
