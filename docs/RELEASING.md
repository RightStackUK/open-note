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
5. **Publishes signed updater artifacts and `latest.json`**, so installed copies
   can update themselves from the app menu.

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

## macOS signing and notarisation

macOS builds are signed with a Developer ID certificate and notarised by Apple,
so they open without a warning. Everything happens in `release.yml`; there is
nothing to do at release time.

This matters more than it used to. Through macOS 14, an unsigned app could be
opened with Control-click → **Open**. macOS 15 removed that: the dialog now
offers only *Done* and *Move to Bin*, and the only way past it is a trip to
System Settings → Privacy & Security. Notarisation is effectively required for
an app people are meant to just download and run.

### The six secrets

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | Developer ID Application certificate, `.p12`, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | The password set when exporting that `.p12` |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: NAME (TEAMID)` |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID (a UUID) |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_KEY_P8` | The `.p8` private key, base64 |

Notarisation uses an **App Store Connect API key** rather than an Apple ID and
app-specific password. It is not tied to one person's account or their 2FA, and
it can be revoked on its own without changing anyone's Apple password.

The release build fails immediately, naming the missing secret, if any of the
six is absent — rather than succeeding and publishing an ad-hoc-signed `.dmg`
that Gatekeeper rejects.

### Getting the certificate

1. **Keychain Access** → menu **Certificate Assistant** → *Request a Certificate
   From a Certificate Authority*. Enter your email, choose **Saved to disk**.
   That writes a `.certSigningRequest`.
2. [developer.apple.com certificates](https://developer.apple.com/account/resources/certificates/list)
   → **+** → **Developer ID Application** → upload the request → download the
   `.cer`.
3. Double-click the `.cer` to add it to your login keychain.
4. In **Keychain Access → My Certificates**, find
   `Developer ID Application: NAME (TEAMID)`. Right-click → **Export** → `.p12`,
   and set a password. That string is also `APPLE_SIGNING_IDENTITY`, verbatim.

A **Developer ID Application** certificate is the one that matters. *Apple
Development* and *Mac App Distribution* certificates cannot notarise software
distributed outside the App Store.

### Getting the API key

[App Store Connect → Users and Access → Integrations](https://appstoreconnect.apple.com/access/integrations/api)
→ **Team Keys** → **+**. Give it the **Developer** role, which is the minimum
notarisation accepts.

Download the `.p8` immediately — Apple allows it exactly once, and a lost key
has to be revoked and replaced. The **Key ID** and the **Issuer ID** are on the
same page.

### Setting the secrets

Run these yourself, from wherever the exports are. Nothing is echoed, and
neither file needs to be kept afterwards — but do not put either one in the
repository.

```bash
base64 -i DeveloperID.p12   | gh secret set APPLE_CERTIFICATE
base64 -i AuthKey_ABC123.p8 | gh secret set APPLE_API_KEY_P8

gh secret set APPLE_CERTIFICATE_PASSWORD          # prompts, input hidden
gh secret set APPLE_SIGNING_IDENTITY --body "Developer ID Application: NAME (TEAMID)"
gh secret set APPLE_API_ISSUER      --body "<issuer-uuid>"
gh secret set APPLE_API_KEY_ID      --body "<key-id>"
```

### Two things get notarised, not one

Tauri notarises the **`.app`** and staples it, then builds the `.dmg` from that
and only *signs* the DMG. That is not enough. Gatekeeper assesses the **DMG**
first, because that is what the browser downloaded and quarantined, so an
un-notarised container shows the warning even when the app inside is perfect.

`release.yml` therefore submits the DMG separately after `tauri-action`, staples
it, and **verifies the result before publishing** — the first signed release
built green while producing a DMG that `spctl` rejected, because nothing
checked.

That is also why the release is created as a **draft**. `tauri-action` publishes
the moment it uploads, which would put the un-notarised DMG in front of people
for the two minutes the fix-up takes. The `publish` job undrafts it once every
platform is done.

### Checking it worked

The signature travels in the `.dmg`, so this works on any Mac:

```bash
spctl -a -vv -t install /Volumes/Open\ Note/Open\ Note.app
codesign -dv --verbose=4 /Volumes/Open\ Note/Open\ Note.app 2>&1 | grep -E 'Authority|TeamIdentifier'
```

Check the **DMG itself**, not only the app inside it — they can disagree, and
the DMG is what Gatekeeper sees first:

```bash
xcrun stapler validate Open.Note_*_universal.dmg
spctl -a -vv -t open --context context:primary-signature Open.Note_*_universal.dmg
```

Both should say `accepted` / `source=Notarized Developer ID`. *Unnotarized
Developer ID* means it was signed but never submitted; *no usable signature*
means it was not even signed.

`stapler validate` is the one that matters for a first launch with no network:
without a stapled ticket the machine has to ask Apple, and an offline machine
cannot.

### Expiry

The API key does not expire. The certificate does, and sooner than the five
years Apple nominally issues: validity is clamped to the **membership** expiry,
so the current one runs out on **1 February 2027**. Check with:

```bash
security find-certificate -c "Developer ID Application" -p \
  | openssl x509 -noout -dates
```

Builds already notarised keep working past that date — the signature carries a
trusted timestamp, so it does not rely on the certificate still being valid.
What stops is signing *new* ones. Renewing the membership and re-issuing the
certificate means re-doing `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD`;
nothing else changes.

That is rare enough to be forgotten entirely, so it is worth a calendar
reminder.

## Windows builds are not signed yet

SmartScreen warns before running the installer; **More info** → **Run anyway**.
Signing needs Azure Trusted Signing (~$10/month) or an EV certificate, and is
tracked as its own issue.

This is independent of **updater signing**. Every updater artifact, including
Windows, is authenticated with Open Note's Tauri updater key before the app
will install it. That prevents a replaced or corrupted download from being
accepted, but it does not give the installer an Authenticode publisher name or
remove SmartScreen warnings from manual downloads.

## In-app updates

**Check for Updates…** reads the stable manifest at
`https://github.com/RightStackUK/open-note/releases/latest/download/latest.json`.
GitHub's `releases/latest` route excludes pre-releases, so a stable install is
never moved onto a beta. Nightlies remain unsigned workflow artifacts and are
not an update channel.

Tauri signs update artifacts with a dedicated minisign key. The public key is
embedded in `apps/desktop/src-tauri/tauri.conf.json`; the private key must never
enter the repository and is supplied to CI through the
`TAURI_SIGNING_PRIVATE_KEY` Actions secret. The release fails before building
if that secret is absent. A local backup currently lives at
`~/.tauri/open-note-updater.key` with owner-only permissions. Back it up in the
team's password manager: losing it means existing installs cannot trust any
future replacement key and therefore cannot auto-update again.

`createUpdaterArtifacts` is `false` in the checked-in configuration and the
tagged release workflow switches it on while stamping the version. This keeps
ordinary local builds and the deliberately unsigned nightly workflow from
requiring access to the production updater key.

The updater package is still the signed/notarised `.app` on macOS. Windows's
NSIS/MSI installer remains unsigned at the OS level as described above. On
Linux, in-place replacement is intended for the AppImage; `.deb` and `.rpm`
users should continue updating through their package installation workflow if
the install location is not writable.

That macOS package is emitted by the **`app`** bundle target, not the `dmg`
one, which is why the macOS leg builds `--bundles app,dmg` even though only the
`.dmg` is offered as a download: `createUpdaterArtifacts` produces the signed
`.app.tar.gz` only when `app` is among the targets built, and a dmg-only build
merely logs a warning and writes a `latest.json` with no macOS entry at all.
Every Mac then fails its update check with *"None of the fallback platforms
`["darwin-aarch64-app", "darwin-aarch64"]` were found"* — before any version
comparison, so even an up-to-date install reports it as an error. The
`Open Note.app.tar.gz` and `.sig` on a release are that artifact; the download
is still the `.dmg`.

The publish job therefore checks `latest.json` for a usable entry per platform
while the release is still a draft, and refuses to publish without one. A
missing platform is otherwise invisible: the build is green, the release looks
complete, and the failure only appears in front of someone who has already
installed. A release published before that check cannot be repaired by editing
the manifest, since the entry it lacks needs a signature over a bundle that was
never built — the fix is to tag again.

## Local builds: the DMG step fails on macOS

`pnpm desktop:build` can fail at the very end with a `bundle_dmg.sh` error and
an AppleScript timeout (`-1712`). The `.app` is already built and fine at that
point — only the disk image is missing.

The cause is that `bundle_dmg.sh` drives Finder over AppleScript to position the
icons in the DMG window, and Finder automation needs a permission macOS only
grants to an app the user has approved. Skip that cosmetic step:

```bash
CI=true pnpm desktop:build
```

This does not affect releases. The GitHub runners set `CI` themselves, so the
release workflow already takes this path and produces a plain, correctly built
`.dmg`.

## Nightly builds

[`nightly.yml`](../.github/workflows/nightly.yml) builds every night and uploads
unsigned artifacts for dogfooding. Those are workflow artifacts, not releases:
they expire after 14 days and are not linked from anywhere public.
