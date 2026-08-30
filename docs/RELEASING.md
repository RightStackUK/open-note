# Releasing

Releases are cut from `main` by pushing a tag. There is nothing to run locally.

```bash
git checkout main && git pull
git tag v0.1.0
git push origin v0.1.0
```

That triggers [`release.yml`](../.github/workflows/release.yml), which:

1. **Checks the tag is on `main`.** A tag on some other commit would publish a
   build of code that never landed, so the workflow stops before spending
   twenty minutes building it.
2. **Stamps the version** from the tag into `tauri.conf.json`, so the bundles
   carry the real version rather than the `0.0.0` placeholder that lives in the
   repo.
3. **Builds on all three platforms** — a universal macOS binary (one download
   for both Intel and Apple silicon), Windows, and Linux.
4. **Publishes a GitHub Release** with the installers attached.

## Versioning

Tags are `vMAJOR.MINOR.PATCH`. A tag containing a hyphen — `v0.2.0-beta.1` —
publishes as a pre-release automatically.

The version in `apps/desktop/src-tauri/tauri.conf.json` stays at `0.0.0` in the
repo on purpose: the tag is the single source of truth, and keeping a version
number in a file just creates a second place to forget to update.

## What users get

| Platform | Files |
|---|---|
| macOS | `.dmg` (universal) |
| Windows | `.exe` (NSIS installer), `.msi` |
| Linux | `.AppImage`, `.deb`, `.rpm` |

### Pre-releases do not get an `.msi`

Windows Installer versions cannot express a non-numeric pre-release identifier,
so there is no valid MSI version for a tag like `v0.2.0-beta.1`. Those tags ship
the NSIS `.exe` only, which has no such restriction. Stable tags get both.

This is a Windows rule rather than a Tauri one, and there is no way around it
short of lying about the version.

## These builds are not signed yet

Until code signing is set up, macOS shows *"cannot be opened because the
developer cannot be verified"* and Windows SmartScreen warns before running the
installer. Both are tracked as separate issues; neither is a bug in the build.

Signing needs paid accounts:

- **macOS** — Apple Developer Program, $99/year, for a Developer ID certificate
  and notarisation.
- **Windows** — Azure Trusted Signing (~$10/month) or an EV certificate.

## Nightly builds

[`nightly.yml`](../.github/workflows/nightly.yml) builds every night and uploads
unsigned artifacts for dogfooding. Those are workflow artifacts, not releases:
they expire after 14 days and are not linked from anywhere public.
