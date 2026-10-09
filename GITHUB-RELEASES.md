# GitHub release packages

The [Package release workflow](.github/workflows/package-release.yml) runs only when a maintainer explicitly dispatches it. It has no push, pull request, tag, schedule, or release triggers. Its default result is an Actions artifact containing the submission ZIP, SHA-256 checksum, report and matching changelog notes. A manual run consumes GitHub Actions time and artifact storage; use the local packaging command by default, and keep remote CI unused unless separately authorized.

From a clean tracked checkout with Node.js 20 or later and an existing local tag at `HEAD`, run:

```sh
npm run package:submission -- --version 2026.10.9 --tag v2026.10.9
```

Use the version in `plugins/android-emulator-plugin/.codex-plugin/plugin.json`. The command requires `v<version>` to exist and resolve to the checked-out commit, runs the build and local tests, and creates:

- `dist/android-emulator-plugin-<version>.zip`
- `dist/android-emulator-plugin-<version>.zip.sha256`
- `dist/submission-report.json`
- `dist/RELEASE-NOTES.md`

The workflow uses the same command without installing package dependencies. Its report identifies the version, source commit and tag, packaged files, ZIP checksum, complete changelog hash and matching version-section hash. Review the report and [LICENSE-AUDIT.md](LICENSE-AUDIT.md), including its unresolved evidence, before deciding whether to distribute the package. Successful packaging checks do not establish legal clearance or OpenAI Registry readiness.

## Maintainer and agent release checklist

1. Read [AGENTS.md](AGENTS.md) and inspect the actual source, supported platforms and previous release tag. Review commits since that tag; for the first published release, review the repository's development history. Ground each changelog statement in those commits and actual behavior. Historical development entries must be identified as development history, not retroactively described as published releases. Do not import history from unrelated or retired repositories.
2. Update root [CHANGELOG.md](CHANGELOG.md) with exactly one `## [<manifest version>]` entry. Classify additions, changes and fixes, and explicitly describe breaking changes, migration steps and upgrade requirements. A missing, duplicate or empty current entry, including headings without notes, fails packaging. Match the package/manifest versions, rebuild the plugin and commit the complete source before assigning an authorized `v<version>` tag to that exact commit.
3. Run the local package command with the exact version and existing tag. It runs the build, bundle checks and full local tests, validates the generated ZIP and its legal copies/component hashes, and writes the four outputs above. Inspect the ZIP independently with a standard archive reader, verify its checksum, and review the license inventory and unresolved evidence against the actual files being distributed.
4. Check exact alignment: tag resolves to report `source.commit`; report/source manifest version matches the tag suffix and ZIP filename; packaged `CHANGELOG.md` hashes match the report; `RELEASE-NOTES.md` matches the report's selected section/hash and the current changelog version. The notes use LF and one final newline. Use this exact notes file as the GitHub release body rather than generic or automatically generated notes.
5. Before an authorized push, tag or release, inspect visible repository CI/integration triggers if no remote CI is required. Keep builds, tests and packaging local by default; do not dispatch Actions, disable workflows or change settings to avoid charges. Remote writes and publication require the maintainer's instruction. If a known trigger or permissions restriction conflicts with that instruction, report the concrete blocker.
6. For an explicitly authorized local GitHub release, verify the existing remote tag against the packaged commit, inspect the report/notes and reject an existing release rather than overwriting it. Attach the ZIP, checksum and report and supply `dist/RELEASE-NOTES.md` as the notes file. Read back the release body, tag and asset hashes/sizes after creation. A GitHub release does not establish OpenAI Registry review status.

Packaging performs no push, tag creation, workflow dispatch, upload or release creation. The ZIP contains the complete committed changelog, and the emitted release notes contain only its matching version entry. Future changelog maintenance and release steps are discoverable through `AGENTS.md`; preserve the project's existing version and archive conventions.

## Run manually when remote Actions use is authorized

GitHub requires a `workflow_dispatch` workflow to be present on the default branch. In **Actions → Package release → Run workflow**, select a branch or tag whose commit is the existing release tag's commit, enter the exact manifest `version`, and enter the existing remote `tag` as `v<version>`. Leave `create_draft` false for an artifact-only run. [GitHub dispatch documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onworkflow_dispatch).

The workflow checks out the dispatch commit by SHA and fetches existing tags. The packaging command rejects a missing tag, a tag resolving to another commit, a mismatched manifest version, a dirty tracked checkout, or a missing/empty current changelog entry. Neither the command nor the workflow creates, moves, or pushes tags. A branch selected at a later commit than the entered tag fails rather than silently packaging different code.

After a successful run, download the `android-emulator-plugin-<version>` Actions artifact. Extract its outer GitHub artifact ZIP to obtain the submission ZIP, checksum, report and release notes. On macOS, verify the submission ZIP from that directory with:

```sh
shasum -a 256 -c android-emulator-plugin-2026.10.9.zip.sha256
```

The artifact is retained for 14 days, subject to repository policy. It wraps the completed submission ZIP, preserving the ZIP's internal hidden files and file modes. The optional draft job downloads that same run's artifact by its immutable artifact ID and fails on an artifact digest mismatch. [GitHub upload action](https://github.com/actions/upload-artifact/tree/v7.0.2), [GitHub download action](https://github.com/actions/download-artifact/tree/v8.0.2).

## Optional unpublished draft

Set `create_draft` true only when intentionally creating a GitHub release draft. After packaging succeeds, the separate draft job checks the freshly fetched tag against the packaged commit, checks the report's version/tag/commit, verifies the ZIP checksum, and checks the notes against the reported section/hash and committed changelog hash. It lists releases with pagination and rejects any existing draft or published release for that exact tag. API failures abort the job. It never overwrites a release or its assets.

The job attaches the ZIP, checksum and report using `gh release create --verify-tag --draft --latest=false --notes-file dist/RELEASE-NOTES.md`. `--verify-tag` requires the tag to exist remotely; `--draft` keeps the result unpublished. Its body is the matching maintained changelog section. The workflow contains no publication step. Maintainers must separately review the draft, license evidence, and attached package before any later publication. If asset upload fails after draft creation, an incomplete draft can remain; inspect it manually rather than expecting a rerun to overwrite it. [GitHub CLI release creation](https://cli.github.com/manual/gh_release_create), [authenticated release listing](https://docs.github.com/en/rest/releases/releases#list-releases).

The package job requests only `contents: read` on the built-in `GITHUB_TOKEN`. The draft job is gated by the boolean input and requests `contents: write`, the permission GitHub uses for release creation. That permission applies to the whole draft job, including its pinned checkout and download actions. Checkout does not persist token credentials, and the draft job does not execute the packaged plugin. No personal token, extra secret, account grant, or repository setting change is required by this workflow. Repository or organization restrictions can still deny its requested permission; retain the artifact-only result and report that failure. [GitHub token permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).

GitHub also documents a release-creation restriction when a target commit changes workflow files relative to the default branch: it can require `Workflows: write`, which the built-in `GITHUB_TOKEN` cannot receive. If that restriction blocks draft creation, use the artifact-only package and resolve the release process separately; this workflow does not add credentials or broaden grants to bypass it. [GitHub release API restriction](https://docs.github.com/en/rest/releases/releases#create-a-release).

The official actions are pinned to full commits verified from their release tags: [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0), [upload-artifact v7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2), and [download-artifact v8.0.2](https://github.com/actions/download-artifact/releases/tag/v8.0.2). Review official release notes and commit identity before updating these pins. [GitHub action pinning guidance](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions).
