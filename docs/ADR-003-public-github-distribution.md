# ADR-003: Public GitHub DMG Distribution

- Status: Accepted
- Date: 2026-07-29
- Decision owner: RavnDock
- Supersedes: The signed/notarized release path for the first public build only

## Context

RavnDock is intended to be freely downloadable by non-technical Mac users. The
first public release should be easy to publish and should not require the project
owner to join the Apple Developer Program before validating product interest.

The application targets Apple Silicon Macs, with a minimum practical target of a
2021 MacBook Pro M1 with 16 GB unified memory. The first public build is
`v1.1.0` and is distributed through the public `mfakbar/pocket-RAG` repository.

## Decision

Publish an unsigned Apple Silicon DMG as a GitHub Release asset. The repository
contains a manually triggered GitHub Actions workflow that:

1. Checks the version tag.
2. Builds the Apple Silicon DMG without Apple signing or notarization.
3. Verifies the DMG disk-image structure on macOS.
4. Uploads the DMG as an Actions artifact.
5. Publishes it to a GitHub Release only when the owner explicitly selects the
   `publish` input.

The README and every release must clearly tell users that RavnDock is independently
distributed and not Apple-signed. Users must be told how to approve the first
launch through macOS Privacy & Security.

## Scope

- Supported architecture: Apple Silicon (`arm64`).
- Minimum practical reference: 2021 M1 Mac with 16 GB memory.
- Release asset: `RavnDock-1.1.0-arm64.dmg` plus a SHA-256 checksum file.
- Repository: `https://github.com/mfakbar/pocket-RAG`.
- Privacy policy: [`PRIVACY_POLICY.md`](PRIVACY_POLICY.md).
- Support: `mfa.akbar@gmail.com` and `muakbar@cisco.com`.

## Consequences

### Benefits

- No Apple Developer membership, certificate, notarization key, or GitHub secret
  is needed for the first public release.
- GitHub provides versioned release notes and a clear download location.
- The release process remains repeatable and can later add signing without
  changing the product's distribution model.

### Costs and risks

- macOS Gatekeeper will warn users because the app is not signed or notarized.
- Users must manually approve the first launch.
- Users have less assurance that the downloaded binary was identified by Apple.
- Public releases must include checksums and a clear source repository so users can
  verify what they downloaded.
- A signed and notarized build should be considered later if installation friction
  becomes a significant adoption barrier.

## Release hygiene

- Do not include development knowledge bases, chat history, credentials, or local
  paths in the repository or DMG.
- Build from a clean checkout and test the DMG on a clean supported Mac account.
- Keep release tags immutable in practice: do not replace a published asset with a
  different binary.
- Add a SHA-256 checksum beside each public DMG.
- Keep the privacy policy and support contacts visible in the repository.
