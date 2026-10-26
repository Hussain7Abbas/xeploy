# Phase H: Documentation and End-to-End Verification

[Main tracker](main.md)

- Status: Complete
- Estimate: 5 points
- Depends on: [Phase G](07-release-integration.md)

## Outcome

As a contributor or user, I can understand the supported formats and configure a mixed release with confidence backed by automated tests.

## Test Tasks

- [x] Retain existing Bun argument and disposable-repository release tests.
- [x] Add fixtures for every supported source format and platform field family, including comments, unusual whitespace, line endings, inherited settings, malformed files, and duplicate/conflicting sources.
- [x] Verify minimal edits and no unintended dependency or engine compatibility changes.
- [x] Cover missing umbrella/child `VERSION` initialization from applicable tags, interactive defaults, and configured unattended initialization.
- [x] Exercise differently typed umbrellas and apps in independent/unified mono and meta repositories, including selected subsets and actual submodule paths.
- [x] Test RC/final translation, multi-environment reuse, promotion, republish, retries, counter bounds, shared-source conflicts, and `create_tag: false`.
- [x] Verify Go module tag formatting, tag scoping/collisions, and migration stops before mutations.
- [x] Exercise failed preflight and local write recovery; check clean working trees and unchanged remote refs where failure must prevent release mutations.
- [x] Prove target SDKs, engines, and project scripts are not required or executed.
- [x] Keep Git tests isolated in disposable repositories and local bare remotes. Mock GitHub operations; do not publish real releases while testing.

## Documentation Tasks

- [x] Update README with the supported-format matrix and precise limits for computed or ambiguous sources.
- [x] Document project/source overrides, native version translation, platform counters, release-state files, and `VERSION` initialization.
- [x] Include mixed mono/meta examples with different umbrella/app ecosystems and manifestless projects.
- [x] Explain shared-source selection conflicts, Go module tags, manual import-path migrations, and recovery after partial remote completion.
- [x] Preserve existing JavaScript guidance and document any public API compatibility changes.
- [x] Update AGENTS.md to describe implemented structure, commands, tests, and conventions.
- [x] Update phase records and `main.md` with completed checks and implementation references.

## Required Commands

Run from the repository root using Bun for dependencies and scripts:

```sh
bun run test
bun run typecheck
bun run lint
bun run build
node dist/cli.js --version
```

If dependency changes are needed during implementation, use `bun add` or `bun install`. Keep the published CLI compatible with its documented Node runtime; Bun is the development/test toolchain.

## Acceptance Criteria

- [x] Every supported adapter and platform-field family has passing acceptance coverage.
- [x] Mixed-repository end-to-end tests and existing JavaScript regressions pass.
- [x] All required commands pass, with results recorded below.
- [x] Documentation describes actual implemented behavior and does not claim unsupported runtime evaluation or source migration.
- [x] Every phase is complete in the main tracker with evidence.

## Implementation Record

- Changes: Completed native-source fixtures, mixed-repository releases, historical snapshots, durable recovery, and contributor/user documentation. No runtime dependencies were added. The Bun test script now allows 60 seconds per integration test for disposable multi-repository Git operations.
- Validation: `bun run test` passes **116 tests / 412 assertions** across two files. `bun run typecheck`, `bun run lint`, `bun run build` (ESM and declarations), `node dist/cli.js --version` (**1.5.0**), and built CLI help all pass. `git diff --check` passes.
- Documentation: README covers the format matrix, explicit sources, native mappings and bounds, VERSION initialization, shared fields, Go migration stops, historical promotion/republishing, state and journal files, API compatibility, and recovery limits. AGENTS.md describes the implementation modules and verification rules. Every phase and the main tracker are synchronized.
- Blockers: None.

## Verification Evidence

- Baseline: 16 tests passed before v2 implementation; 71 passed at the preceding milestone. Final suite: 116 passing tests.
- Observed RED → GREEN includes the initial adapters and mixed discovery, then MSBuild local/shared and property precedence, inherited numeric fields, Prefix suffix insertion, Python typed constants/file arrays/SCM tag reachability, Maven CI composite/CLI sources, Cargo registry-reference isolation, Unity layout and commented plist guards, missing Godot Windows fields, Android offset bounds, public preflight ordering/collisions, shared platform ownership, independent mixed-meta paths, detached children, canonical-state conflicts, and remote recovery. Passing additions such as Hatch/VB.NET/provider tables are coverage and are not claimed as red cycles.
- Recovery retries the actual failed operations: simulated partial local writes are restored and reapplied; rejected release/environment/production branch pushes are retried successfully; a partial meta release continues through RC/final without re-bumping completed children; a fake GitHub create that succeeds remotely then returns an error is resumed without moving its tag or creating another release.
- Historical tests use recorded RC gitlinks, preserve newer develop work, skip unchanged final children, increment the old Flutter build once, restore original branches, and republish root/child RC releases without file changes. Annotated tags retain their tag objects and commits.
- Final pattern scan covered **26 source files**, **9 filesystem mutation sites**, **66 literal process calls** (only Git and GitHub CLI), and **3 package.json references**. Five dynamic process forwarders preserve argv arrays without a shell. Writer hits are classified as validated batch/rollback, explicit config persistence, owned Git-local journal persistence, owned temporary-checkout cleanup, or the retained single-file legacy JSON helper. Package references are CLI self-version, JavaScript discovery, and Unity package compatibility; none is a remaining package-only release assumption.
- Diff review included tracked changes and the new source/model/adapter/edit/state/journal/history helpers. Biome applied import ordering and 100-column formatting in touched modules; the unrelated semver-only formatting change was removed. No independent reviewer was used.
- Validation used disposable repositories, local bare remotes, and fake GitHub operations. No live release was created, no package was published, and the repository version remains 1.5.0. SDK/engine builds and arbitrary runtime/provider evaluation are intentionally outside the approved scope; unsupported layouts fail with source guidance.

## References Checked During Implementation

- [Flutter Android version/build mapping](https://docs.flutter.dev/deployment/android#update-the-apps-version-number)
- [Flutter Windows version mapping](https://docs.flutter.dev/deployment/windows#updating-the-apps-version-number)
- [Current Apple build-number format](https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleversion)
- [Windows file-version representation](https://learn.microsoft.com/en-us/windows/win32/api/verrsrc/ns-verrsrc-vs_fixedfileinfo)
