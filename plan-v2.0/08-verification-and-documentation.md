# Phase H: Documentation and End-to-End Verification

[Main tracker](main.md)

- Status: Not started
- Estimate: 5 points
- Depends on: [Phase G](07-release-integration.md)

## Outcome

As a contributor or user, I can understand the supported formats and configure a mixed release with confidence backed by automated tests.

## Test Tasks

- [ ] Retain existing Bun argument and disposable-repository release tests.
- [ ] Add fixtures for every supported source format and platform field family, including comments, unusual whitespace, line endings, inherited settings, malformed files, and duplicate/conflicting sources.
- [ ] Verify minimal edits and no unintended dependency or engine compatibility changes.
- [ ] Cover missing umbrella/child `VERSION` initialization from applicable tags, interactive defaults, and configured unattended initialization.
- [ ] Exercise differently typed umbrellas and apps in independent/unified mono and meta repositories, including selected subsets and actual submodule paths.
- [ ] Test RC/final translation, multi-environment reuse, promotion, republish, retries, counter bounds, shared-source conflicts, and `create_tag: false`.
- [ ] Verify Go module tag formatting, tag scoping/collisions, and migration stops before mutations.
- [ ] Exercise failed preflight and local write recovery; check clean working trees and unchanged remote refs where failure must prevent release mutations.
- [ ] Prove target SDKs, engines, and project scripts are not required or executed.
- [ ] Keep Git tests isolated in disposable repositories and local bare remotes. Mock GitHub operations; do not publish real releases while testing.

## Documentation Tasks

- [ ] Update README with the supported-format matrix and precise limits for computed or ambiguous sources.
- [ ] Document project/source overrides, native version translation, platform counters, release-state files, and `VERSION` initialization.
- [ ] Include mixed mono/meta examples with different umbrella/app ecosystems and manifestless projects.
- [ ] Explain shared-source selection conflicts, Go module tags, manual import-path migrations, and recovery after partial remote completion.
- [ ] Preserve existing JavaScript guidance and document any public API compatibility changes.
- [ ] Update AGENTS.md to describe implemented structure, commands, tests, and conventions.
- [ ] Update phase records and `main.md` with completed checks and implementation references.

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

- [ ] Every supported adapter and platform-field family has passing acceptance coverage.
- [ ] Mixed-repository end-to-end tests and existing JavaScript regressions pass.
- [ ] All required commands pass, with results recorded below.
- [ ] Documentation describes actual implemented behavior and does not claim unsupported runtime evaluation or source migration.
- [ ] Every phase is complete in the main tracker with evidence.

## Implementation Record

- Changes: None.
- Validation: Not run; planning only.
- Blockers: None recorded.
