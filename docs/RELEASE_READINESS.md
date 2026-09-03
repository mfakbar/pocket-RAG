# RavnDock Release Readiness

## Complete in the project

- [x] App icon, privacy manifest, macOS entitlements, and DMG build configuration
- [x] Local privacy statement
- [x] Clean-user-data packaging behavior
- [x] UI test checklist and recovery copy
- [x] Unsigned direct-download release preflight and DMG verification scripts
- [x] GitHub Actions verification, security scanning, and opt-in DMG release workflow

## Requires Apple Developer credentials

- [x] Confirm unsigned public DMG distribution for GitHub
- [ ] Add a signed/notarized release later if Gatekeeper friction becomes too high
- [ ] Create Apple Distribution signing identity and Mac App Distribution provisioning profile for the App Store build
- [ ] Add App Store Connect app record, screenshots, category, support URL, and privacy answers
- [ ] Enable notarization for direct-download DMG builds using Apple credentials
- [ ] Test the signed build on a clean Mac user account

## Distribution paths

- **GitHub DMG:** Ready without Apple credentials. Users will need to approve the
  first launch in macOS Privacy & Security. Follow [`GITHUB_RELEASE.md`](GITHUB_RELEASE.md).
- **Mac App Store:** Intentionally blocked until RavnDock ships a complete,
  signed local runtime inside the application bundle. Follow
  [`APP_STORE_RELEASE.md`](APP_STORE_RELEASE.md).

Do not place Apple certificates, provisioning profiles, API keys, or notarization
passwords in this repository.
