# Android emulator plugin ZIP preparation

This is an intact Codex plugin preparation archive. It preserves the local MCP
server, pinned emulators and connected devices, comparison/live panels, settings,
mentions, APK handling, SDK integration and screen memory. Public Registry review
remains incomplete.

## Build locally

From a clean, committed checkout with Node.js 20 or newer:

```sh
npm run package:submission
```

The command rebuilds/checks the shared runtime, runs all local tests, copies only
tracked plugin files, applies `release/submission.json` to a separate author copy,
validates that copy and the actual ZIP, then writes:

- `dist/android-emulator-plugin-2026.10.9.zip` (filename follows the manifest version)
- the matching `.zip.sha256` checksum
- `dist/submission-report.json` with source commit, complete inventory, checks and gaps
- `dist/RELEASE-NOTES.md`, the matching version entry from committed `CHANGELOG.md`

It performs no push, upload, tag creation, workflow dispatch or publication.
Tests use local loopback servers and mock commands; no CI service is needed.
Stored ZIP entries use fixed timestamps, stable ordering and committed Git file modes/blobs,
so the same source commit produces identical ZIP bytes across hosts. The report
records the command's checkout commit; existing tag validation is optional locally:

```sh
npm run package:submission -- --version 2026.10.9 --tag v2026.10.9
```

The tag must already exist and resolve exactly to the current commit. The command never
creates or moves it. A dirty checkout or a rebuild that changes tracked files
fails; review/build/commit those source changes before rerunning.

## Maintain release notes

Before each release, update the root `CHANGELOG.md` with exactly one
`## [<manifest version>]` entry describing the actual tagged changes and upgrade
requirements. A missing, duplicate or empty entry, including headings without
notes, fails packaging. Commit the changelog together with the version and rebuilt
plugin before assigning an authorized release tag to that exact commit.

The ZIP includes the complete committed changelog. The report records its SHA-256,
the selected version section and that section's SHA-256. `RELEASE-NOTES.md` contains
the exact selected section with LF line endings and one final newline. Use this
file as the matching GitHub release body; the optional draft workflow verifies it
against the report and the committed changelog. Do not substitute generated or
generic notes for this maintained entry.

## What the author copy changes

The source manifest and SDK/runtime behavior remain intact. The upload copy keeps
the existing supported Codex format (`.codex-plugin/plugin.json`, `.mcp.json`);
there is no root `.app.json`, app binding, or fabricated remote endpoint. It uses
the preserved website/support URLs, publisher text, icons and screenshot paths,
a 30-character-or-shorter subtitle, factual desktop requirements and release notes. The
brand color is slightly darker for the required 2:1 white contrast; the SVGs are
unchanged, square 64×64 assets permitted by current official documentation.

The three existing PNG documentation screenshots are retained and checked for
contained paths, valid PNG structure/CRCs, dimensions and hashes. Their 1600-pixel
widths do not meet the portal's 706-pixel review-image width. The report records
that mismatch and their unverified review-evidence status; copying these source
images does not complete the starter-prompt screenshot requirement.

Five positive and three negative review cases are included in the manifest.
They are **drafted, not run as portal review cases**. Local unit/integration tests
and the earlier scrcpy emulator smoke test are separate evidence. No demo video,
credentials, fixture URL or successful portal scan has been fabricated.

## Public-review checklist

1. **Execution route:** OpenAI documents remote HTTPS submission through With MCP.
   For servers that must run locally, it directs authors to their OpenAI contact
   for local MCP support. This plugin needs local SDK/AVDs and Codex chat context;
   a ZIP alone supplies no hosted service. Obtain that supported route before
   claiming public-review readiness. Keep local functionality while resolving it.
2. **Publisher and availability:** source text says Matt McKenna; the selected
   verified publishing identity is not confirmed. Country targeting and commerce
   declarations are absent until the owner supplies them; no worldwide/free
   defaults are silently inserted.
3. **Listing URLs:** `websiteURL` is the public GitHub repository and `supportURL`
   is its issue tracker, both preserved from upstream. `privacyPolicyURL` and
   `termsOfServiceURL` are missing. The owner must select/publish appropriate
   pages; a drafted document or repository Apache license is not a published
   privacy policy or service agreement. Packaging checks HTTPS syntax; live
   content/access verification is a separate step for any newly supplied URLs.
4. **Review evidence:** record and verify a real walkthrough in the supported
   host, host it at a reviewer-accessible URL, and run the five positive/three
   negative cases against the submitted version. Custom UI requires correctly
   sized review screenshots for the starter prompts; the preserved manifest and
   README screenshots are source documentation with unverified review context.
5. **Portal-only work:** selected identity/domain verification, required skill
   and tool scans, tool-annotation justifications, supported reviewer access and
   owner attestations remain uncompleted. Keep credentials in secure portal
   fields, never this ZIP. Upload, submission for review and publication are
   separate actions requiring the owner's instruction.
6. **Licensing context:** legal copies/notices accompany this archive and managed
   Minimap installs. See `LICENSE-AUDIT.md` for exact components and owner facts
   concerning applicable Google CLI terms, naming and source screenshots. No
   license or agreement is replaced by a submission checklist.

The local report distinguishes package checks from these review requirements.
It is not the registry's automated validator and does not guarantee acceptance.

## Review walkthrough draft

Use a disposable installed API 36 AVD, an authorized reviewer-owned USB phone and
sample content. In a fresh Codex desktop chat, start two read-only copies with
distinct device IDs; successful startup opens the panel automatically. Demonstrate
a phone move from a second disposable review chat only after the user's panel
confirmation. With multiple pins, explicitly target an emulator's returned ID,
inspect real Settings controls, tap Display and verify the destination, then
save/share that device's screenshot. Read diagnostics without restarting and
explain the phone's emulator-only capability limits. Demonstrate unsupported
iPhone/cloud requests and an ambiguous multi-device mutation being declined or
clarified. Show actual results and the packaged version. Handle applicable SDK/CLI
agreements before navigation use.
Record only after rehearsing; inspect playback and exclude private content.

Manual GitHub artifact/draft release instructions are in `GITHUB-RELEASES.md` in
the source repository. Registry publication is independent of GitHub releases.

Official sources:

- [Accepted formats and field mappings](https://developers.openai.com/plugins/deploy/submission#complete-metadata-examples)
- [Local MCP public-submission route](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)
- [Listing, icons, URLs and review requirements](https://developers.openai.com/plugins/deploy/submission-errors)
- [Tool annotation definitions](https://developers.openai.com/plugins/build/mcp-server#tool-annotations-and-elicitation)
