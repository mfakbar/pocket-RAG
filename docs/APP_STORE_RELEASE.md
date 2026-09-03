# RavnDock Mac App Store Release Preparation

RavnDock is configured for Mac App Store packaging, but packaging is intentionally
blocked until the runtime and Apple account requirements below are complete.

## Current compliance blocker

Apple App Review Guideline 2.5.2 requires App Store apps to be self-contained and
prohibits downloading or installing executable code that adds app functionality.
RavnDock currently downloads Ollama, uv, Python, and Python packages during setup.

Before an App Store build can be produced:

1. Bundle a pinned Ollama executable under `build/runtime/ollama`.
2. Bundle the complete Python interpreter and locked RAG environment under
   `build/runtime/rag-backend`.
3. Sign every nested executable and native library with the app.
4. Make the packaged app use those bundled runtimes and disable executable runtime
   downloads. Model weights may remain explicit user-approved resource downloads.
5. Test setup, sync, chat, model management, and folder access in a `mas-dev` build.

The preflight command reports this and other blockers:

```bash
npm run appstore:check
```

Strict packaging commands stop when any blocker remains:

```bash
npm run build:mas-dev
npm run build:mas
```

## Apple account inputs

- Apple Developer Program membership.
- A final reverse-domain Bundle ID registered as an explicit App ID.
- Apple Development and Apple Distribution certificates installed in Keychain.
- A matching Mac development profile for `mas-dev` and Mac App Store distribution
  profile for release.
- The legal seller/copyright name.
- Public support and privacy-policy URLs.

Keep certificates, private keys, and provisioning profiles outside Git. The project
ignores `.p12`, `.provisionprofile`, and `app-store/private/`.

Place downloaded profiles at these exact paths:

- Development: `build/RavenDock-Development.provisionprofile`
- Distribution: `build/RavenDock.provisionprofile`

Replace `com.pocketai.app` at the top of `electron-builder.yml` only after the
final Bundle ID has been registered in the Apple Developer portal.

## App Store Connect inputs

- Create the macOS app record with the final Bundle ID and a unique SKU.
- Use Productivity as the category to match the app bundle.
- Complete the privacy label. The current product design does not intentionally
  collect data or track users; verify this again after the final dependency audit.
- Upload one to ten Mac screenshots at one accepted 16:10 size. Use sanitized demo
  documents and remove personal paths, file names, and chat history.
- Add App Review contact details and explain the model download size and local-only
  processing in Review Notes.
- Validate the signed package before any upload. Do not upload from automation until
  a `mas-dev` build passes clean-machine testing.

## Included preparation

- App Sandbox and inherited helper entitlements.
- User-selected folder and app-scoped bookmark entitlements.
- Persistent security-scoped folder access in the Electron main process.
- Network client/server entitlements for local inference and approved downloads.
- Privacy manifest declarations for file timestamps, system uptime, disk space, and
  app-owned preferences.
- Metadata and privacy-policy drafts under `app-store/` and `docs/`.
- A preflight script that checks the Bundle ID, bundled runtimes, Xcode tools,
  signing identity, and required packaging files.

## Primary references

- https://developer.apple.com/app-store/review/guidelines/
- https://developer.apple.com/macos/distribution/
- https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk
- https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/
- https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide/
