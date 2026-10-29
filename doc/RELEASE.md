# Release

The SpineTree release gate that preceded this section described the former
`@spinetree/plugin`; it is archived with that package in
[`archive/spinetree_plugin_20261027`](../archive/spinetree_plugin_20261027/RELEASE.md).

## npm publishing

The public Pi extension is `@spinejit/pi-spinejit`; SDK and host remain
`@spinejit/spine-sdk` and `@spinejit/spine-host`; each is versioned on its own.
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
