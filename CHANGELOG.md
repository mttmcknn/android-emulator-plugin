# Changelog

Release entries describe the exact tagged source. Update this file before each
release; local packaging requires a nonempty entry matching the manifest version.

Historical dates below are Git committer dates in UTC, not release publication
dates. Versions 2026.10.7 and 2026.10.8 describe development source history; neither
had a published GitHub release. Available history starts at this repository's
initial commit; no history from a retired or separate repository is inferred.

## [2026.10.9]

First GitHub release, combining the existing plugin, the pinned-device update in
[`75bfbeb`](https://github.com/mttmcknn/android-emulator-plugin/commit/75bfbeb927feb2c0c98a134fbc30c303f4b5f916)
(committed 2026-10-09 at 15:54:09 UTC), and the locally validated release and
licensing work. GitHub records the publication time for this release.

### Added

- Pin multiple emulators and USB-connected Android devices to one Codex chat,
  switch devices from the live panel, and compare device screens side by side.
- Enforce exclusive device ownership between chats. Moving a connected device
  requires confirmation in the panel; unpinning a phone leaves it running.
- Provide live device control, APK installation, screenshots and recordings,
  app and accessibility inspection, Logcat, and emulator device conditions.
- Retain local screen memory and remembered navigation using separately
  acquired Minimap and Google's Android CLI.
- Build reproducible versioned ZIPs locally with checksums, an archive inventory,
  committed source provenance, legal files and this changelog.
- Provide an opt-in manual GitHub Actions packaging workflow; its default
  produces artifacts, with an optional unpublished draft release.

### Changed

- Use readable Codex tool names such as `start_emulator`, `inspect_screen` and
  `tap_screen`, while retaining runtime operation IDs at the host boundary.
- Open the live panel after successful startup in supported Codex hosts.
- Scope actions to an explicit device when a chat has several pinned devices.
- Include the existing documentation screenshots and support URL in the package.

### Fixed

- Update the bundled scrcpy Android server to 5.0.1 and verify its official hash.
- Retain installable first-party LICENSE/NOTICE files, scrcpy/Kotlin component
  notices, Android robot attribution, and exact application/Rust notices beside
  managed Minimap installations.
- Correct tool annotations for persisted captures, screen memory, dependency
  downloads and destructive panel operations.
- Reject stale bundles, dirty release sources, unsafe or inconsistent ZIP
  entries, mismatched versions/tags, and missing release changelog entries.

### Breaking changes for existing installations

- Reconnect or reload the plugin to refresh Codex's renamed tool discovery.
  Integrations using discovered tool names should adopt the friendly names;
  runtime operation IDs remain internal, and incoming MCP integrations must use
  the refreshed friendly tool names.
- Use the returned device ID for actions when several devices are pinned.
  Emulator-only conditions and snapshots are unavailable on physical phones.

### Requirements and review status

- Requires Node.js 20 or newer, Codex desktop, and separately installed Android
  SDK/platform tools. Emulators also need an installed system image. USB devices
  require USB debugging and the device's own authorization prompt.
- Clipboard export requires macOS. Video frame sampling uses user-installed
  FFmpeg/ffprobe. Google CLI terms are handled by each user before first use;
  the release does not accept agreements or bundle these external tools.
- The preserved local Codex MCP package has not completed OpenAI Registry review.
  Public review requires its supported execution route and remaining publisher,
  policy and review materials described in PREPARATION.md in the ZIP.

## [2026.10.8]

**Historical development version; not a published GitHub release.** Source work
was committed on 2026-10-08, from 10:30:27 through 19:33:31 UTC, on the license-audit
and submission branches. It was later published as a source branch and delivered
as a preparation ZIP; those events were not a GitHub release.

### Changed and fixed

- [`5be7ccc`](https://github.com/mttmcknn/android-emulator-plugin/commit/5be7cccacbd8250bd4aa3ca0d75e34374fb195a2):
  update the Android scrcpy server from 5.0 to 5.0.1, verify its official hash,
  retain first-party legal files in generated/retained bundles, add embedded
  component notices and Android robot attribution, and document separately
  acquired navigation tools and their applicable terms.
- [`83394e8`](https://github.com/mttmcknn/android-emulator-plugin/commit/83394e8974657b44152052481ed63b39ec2716db):
  complete exact managed Minimap application/Rust runtime notices and refine
  the evidence and limitations in the release license audit.
- [`9e5e5b7`](https://github.com/mttmcknn/android-emulator-plugin/commit/9e5e5b74c736c2e926677c42db008ab3e173c8ec):
  incorporate the upstream repository website link without dropping the audit
  and server changes.
- [`9782191`](https://github.com/mttmcknn/android-emulator-plugin/commit/97821915c32bba5867273aecc6528608b6a37907):
  add the local submission ZIP command, separate listing/review metadata copy,
  deterministic ZIP checks, preparation documentation and opt-in manual
  artifact/draft-release workflow; correct persistence/download tool hints.
- [`6696eb3`](https://github.com/mttmcknn/android-emulator-plugin/commit/6696eb3f37eb179a9e7f360daf6ac419cb700a43):
  bind preparation overlays and archive provenance to committed Git bytes,
  preserving output despite clean checkout permission/line-ending differences,
  and update the affected tool-hint assertions.
- [`616bbf3`](https://github.com/mttmcknn/android-emulator-plugin/commit/616bbf30b0e054ec2e931a13277d4810e850fae5):
  correct the documented subtitle length to 26 characters.

### Requirements and release status

- Retain the existing Node.js 20+, Codex desktop and separately installed SDK
  requirements. The plugin ships the Android server and notices, not desktop
  scrcpy, FFmpeg, SDL, ADB, Node, Minimap or the Google CLI binaries.
- Public Registry review and owner-specific policy/branding facts remained
  unresolved. The historical ZIP was a preparation artifact, not approval or
  evidence of a public release.

## [2026.10.7]

**Historical development version; not a published GitHub release.**
[`4631266`](https://github.com/mttmcknn/android-emulator-plugin/commit/46312662da5105863137434a6bbc296548cfbd64)
is the initial repository commit, committed 2026-10-07 at 19:38:41 UTC. Its author
timestamp is 15:15:18 UTC on the same date; neither timestamp is a release date.
The imported code's earlier development chronology is not established by this
repository and is not reconstructed here.

### Initial source snapshot

- Add the installable Codex plugin, local Node/MCP helper and browser device
  panel, with a dedicated emulator for each chat.
- Provide AVD creation/start/stop, live control, APK installation, app and UI
  inspection, device conditions, screenshots, recordings, snapshots and Logcat.
- Include local screen memory/navigation, selectable backends, capture sharing,
  skills, device/setup management, documentation screenshots and local tests.
- Bundle the scrcpy Android server 5.0 with a separate JavaScript/browser client;
  declare Apache-2.0 for first-party source and require external Android SDK tools.

### Documentation update

- [`a30889c`](https://github.com/mttmcknn/android-emulator-plugin/commit/a30889c255a95f23d13bd88918083a7b77f5d424),
  committed 2026-10-08 at 19:01:23 UTC, points the plugin website URL to this GitHub
  repository. The manifest/runtime version stays 2026.10.7; this is a source
  metadata update, not a new release event.
