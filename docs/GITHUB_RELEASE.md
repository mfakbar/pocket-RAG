# GitHub DMG Release Guide

This project can build an unsigned Apple Silicon DMG and attach it to a GitHub
Release. The workflow never publishes automatically.

## One-time setup

1. Create a public repository named `pocketai` under `mfakbar`.
2. Push the project to its `main` branch.
3. Keep the repository's Actions enabled. No Apple credentials or GitHub secrets
   are required for this unsigned release path.

The DMG is intentionally not signed or notarized. macOS will warn users on first
launch. Tell users to try opening RavnDock once, then go to **System Settings →
Privacy & Security → Open Anyway** and confirm. Apple documents this override for
apps from unidentified developers.

## Release process

1. Update `package.json` to the intended three-part version, currently `1.1.0`.
2. Run `npm run release:check` locally.
3. Push the tested commit and create the matching tag `v1.1.0`.
4. In GitHub Actions, run **Release macOS DMG** with tag `v1.1.0` and `publish`
   off.
5. Download and test the generated DMG on a clean M1 Mac with 16 GB memory.
6. Run the workflow again with `publish` on to attach the verified DMG to a
   GitHub Release.

The workflow checks that the DMG is a valid macOS disk image and confirms that
signing and notarization are intentionally not part of this release.

## Local release commands

```bash
npm run release:check
npm run release:dmg
npm run release:verify-dmg
```

`release:dmg` builds only the Apple Silicon target. It does not build Intel
(`x86_64`) or universal binaries.
