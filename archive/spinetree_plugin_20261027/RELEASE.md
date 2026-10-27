# SpineTree Release Gate

Status: gate record for the current plugin boundary. This is not a claim that
every SpineTree path is production-ready.

## Architecture

One state has one owner.

- `@spinejit/pi-spinejit` owns canonical Spine scope transitions, sampling,
  projection, compaction, recovery, and Spawn.
- `@spinejit/spine-host` owns registration, dependency order, namespaces,
  private storage, lifecycle, and session requests. It is not a second runtime.
- `@spinetree/plugin` is an ordinary contributor. It owns only the `spinetree`
  tool, command, and storage namespaces, and only when its selected load units
  claim them.
- ProjectBranch, Agent, WorkingBinding, Pi session, mailbox receipt, and
  SpineScope stay distinct. They meet through typed bindings.

`createSpineTreePlugin()` does not create `.spinetree`, start Git, or dispatch
mail by itself. The caller passes a store, registry, mailbox, and session
adapter, and calls `dispatchSpineTreeMailbox` outside the sending tool.

## Contract

- No explicit adapters: tools keep their input schema and return
  `contract-only`. No workspace state is created.
- `load: []` claims no namespace and registers no tools. Omitting `load` keeps
  the ProjectTree and collaboration units.
- Collaboration requires ProjectTree. The Pi session adapter requires
  collaboration. Navigation is the separate `@spinejit/spinetree-navigation`
  extension and does not own the canonical runtime.
- `spinetree_send` validates addresses and enqueues. It does not wait for the
  recipient. The same `requestId` and message returns the existing receipt; a
  different message under that key fails.
- A delivery lease may record `bindingId`. `delivered`, `release`, `fail`, and
  `observed` reject a different binding. After prompt completion, dispatch
  re-reads the stored lease and current binding. A changed token raises
  `lease-conflict` and does not overwrite the newer delivery.
- Registry resolution failure acquires no lease. An unknown or ended recipient
  becomes `failed`.
- Declared `agentId` is checked against the registry. The host has no caller
  identity field, so this is not authentication.

## Migration

Existing callers that omit `load` keep the previous factory behavior. To select
units, pass `load` with dependency order:

```ts
createSpineTreePlugin({
  load: ["@spinetree/project", "@spinetree/collaboration"],
  store,
  registry,
  mailbox,
})
```

Receipts written before `bindingId` remain valid. Dispatch stays caller-owned.
Do not point the old Unix live-model harness at current Pi 0.87.1: that server
no longer exports the helpers it imports. The passed real-model path is the
in-process `AgentSessionRuntime` smoke.

## Test report

Package suite, recorded at `6794884`:

```bash
cd scaffold/spine-sdk-plugin && npm test
```

SDK 6, Host 18, canonical 147, SpineTree 68, navigation 18. **257 passed / 0
failed.**

The current public-package preparation commit `f33d0a2` reran the suite with
the current sources: SDK 8, Host 18, canonical plugin 175, SpineTree 161, and
navigation 18; **380 passed / 0 failed**. The three packages also pass
`npm publish --dry-run --access public` and the core-source verification.

The source repository is
[`GhabiX/spine-plugin`](https://github.com/GhabiX/spine-plugin). The
manual `.github/workflows/publish.yml` workflow publishes one selected package.
Configure npm Trusted Publishing for that package before dispatching it.

Integration evidence is in `scaffold/project-tree-poc`, not in this package:

| Check | Commit | Result |
| --- | --- | --- |
| mailbox binding fence | `6731aed` | included in the 257 package tests |
| spawn reservation restart | `8b8d8b2` | reservation tests passed |
| vertical recovery path | `78f0219` | `spinetree vertical poc ok` |
| deterministic recovery matrix | `6d3f985` | `spinetree d12 matrix ok` |
| grok-4.7 collaboration | `f79c493` | `spinetree real-model collaboration ok` |

The grok run used `cachetree/grok-4.7` at `http://127.0.0.1:4000/v1`. Two
sessions called read, send, and observe. The reply was `17 * 19 = 323`. Both
receipts ended `observed`.

## What can be used

Usable when the caller opts in with explicit adapters and handles the typed
failures covered above:

- host owner conflict, namespace, dependency rollback, and dispose
- ProjectTree read and branch-revision change through one Git `.spinetree` store
- queued mailbox send, request idempotency, lease fencing, and observe
- explicit load selection

Experimental, because the proof lives in the poc and not in a deployed host:

- vertical Pi/Git/mailbox recovery smoke
- durable Spawn reservation and restart faulting
- Pi 0.87.1 context-edit poc
- one grok-4.7 in-process collaboration run

## Known limitations

- A source archive can become durable before its post-commit intent is
  appended. The accepted result is `reconciliation-required`, not a guessed
  import.
- Archive state and `.spinetree` are not one atomic commit. Exactly-once across
  those stores is not claimed.
- There is no cross-process lock beyond Git expected-HEAD CAS and the receipt
  lease token.
- There is no automatic mailbox worker.
- An uncommitted durable Spawn terminal still cannot be finalized through the
  current Pi restart API. That path fails closed.
- The old Unix live-model service is not a supported entrypoint on Pi 0.87.1.

## Rollback

1. Do not register `@spinetree/plugin`, or pass `load: []`. The host keeps its
   base behavior and no `spinetree` namespace is claimed.
2. Register the factory without store, registry, and mailbox adapters. Tools
   stay `contract-only` and no `.spinetree` directory is created.
3. Set scope import off (`scopes: false`) to skip canonical import.
4. Dispose the host registration to drop the live plugin. This does not delete
   an existing Git history. Leave that history in place and stop passing the
   store; deleting it is not the rollback path.

## npm publishing

The public Pi extension is `@spinejit/pi-spinejit`; SDK and host remain
`@spinejit/spine-sdk` and `@spinejit/spine-host`. All three currently use `0.1.0`.
The rename changes the plugin package and host registration identity; compiled
entrypoints and exported subpaths are preserved. Update companion packages
together with their new import and host dependency references.

Run `npm test` and inspect the plugin tarball before publishing. Verify a clean
consumer resolves the published SDK/host and Pi discovers the compiled extension.
The manual workflow defaults to `package: plugin`, so a plugin release does not
attempt to republish existing SDK/host versions. When those versions change,
publish SDK, then host, then plugin as applicable.

A new npm package requires an authenticated first publish or a configured npm
publishing mechanism. The old package's Trusted Publisher setting does not
transfer to the new name. For subsequent OIDC releases configure
`@spinejit/pi-spinejit` with GitHub owner `GhabiX`, repository `spine-plugin`,
and workflow `publish.yml`. The repository was renamed from `spine-sdk-plugin`
on 2026-10-27; update any Trusted Publisher entry that still names the old
repository before the next OIDC release. The Trusted Publisher grants only
`npm stage publish`, so `publish.yml` stages the version; a maintainer then
approves it with 2FA on npmjs.com or with `npm stage approve <stage-id>`.

After publishing and verifying the new package, mark the old version deprecated:

```bash
npm deprecate '@spinejit/spine-plugin@0.1.0' 'Renamed to @spinejit/pi-spinejit. Install with: pi install npm:@spinejit/pi-spinejit. Remove the old package and restart Pi; do not load both.'
```

Deprecation preserves old installations and provides a migration warning.
Only apply it after the new package can be installed. The repository is named
`spine-plugin`; the SDK and host it also contains keep their own package names.

For interactive releases, use a current npm CLI (at least 11.15 for staged
publishing) and `--browser=false` on headless hosts. Complete npm's web 2FA
challenge through its displayed link. If the registry exposes only a
`0.0.0-stage` placeholder, check `npm stage list @spinejit/pi-spinejit` and the
staged version before proceeding. A successful CLI exit alone is not a release
gate: confirm the public version and tarball integrity, then run a normal
registry install and `pi install` before deprecating an old name.

Verify npm metadata, clean installation, the direct Pi detail page, and Pi
catalog search separately. A working detail page does not prove catalog search
inclusion. The `pi-package` keyword and `pi.extensions` are present; discovery
still depends on upstream indexing.

### pi-spinejit 0.1.0 rename validation (2026-10-08)

`npm test`: 380 passed, 0 failed (SDK 8, host 18, Pi plugin 175,
SpineTree 161, navigation 18). Core-source verification passed for 48 files.
The packed plugin passed an isolated npm install using published dependencies;
Pi 0.87.1 loaded one extension with zero errors and all four Spine tools.
All seven exported subpaths imported successfully. Tarball integrity and
compiled entry inclusion were checked before publishing. These are package and
loader checks, not a new live-model evaluation or Pi 1.x compatibility claim.

Migration completed on 2026-10-08: `@spinejit/pi-spinejit@0.1.0` is public;
registry installation, Pi installation/listing, and extension loading passed.
The registry integrity matches the tested tarball. `@spinejit/spine-plugin@0.1.0`
is deprecated with instructions to install the new name; its version remains
available. Pi catalog search still had no match at the final check, so catalog
inclusion is not claimed. The release record is in
[`archive/pi_spinejit_rename_20261008_1722`](../archive/pi_spinejit_rename_20261008_1722/worklog.md).
