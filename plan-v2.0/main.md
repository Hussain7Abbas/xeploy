# Xeploy v2.0 Implementation Plan

## Status

Planning documents only. Implementation has not started. Creating or updating this plan does not authorize implementation.

## Goal

Extend version bumps and GitHub releases to mixed-language single repositories, monorepos, and meta-repositories. The umbrella and every app may use different ecosystems and version sources. Preserve the choice between independent and unified versions.

Builds, tests of target applications, package publishing, SDK/engine execution, and automatic Go import-path migrations are outside this release's scope.

## Phase Tracker

Points are rough relative estimates, not time commitments. All phases are required. Dependencies describe implementation prerequisites, not instructions to delegate work.

| Complete | Phase | Points | Depends on | Status |
| --- | --- | ---: | --- | --- |
| [ ] | [A. Project model and adapter contract](01-project-model.md) | 5 | — | Not started |
| [ ] | [B. Discovery, overrides, and VERSION](02-discovery-and-version-fallback.md) | 8 | A | Not started |
| [ ] | [C. .NET and Python adapters](03-dotnet-and-python.md) | 8 | A | Not started |
| [ ] | [D. Java, Rust, and Go adapters](04-java-rust-and-go.md) | 8 | A | Not started |
| [ ] | [E. Unity adapter](05-unity.md) | 5 | A | Not started |
| [ ] | [F. Godot and Unreal adapters](06-godot-and-unreal.md) | 8 | A | Not started |
| [ ] | [G. Release-flow integration](07-release-integration.md) | 8 | B–F | Not started |
| [ ] | [H. Documentation and end-to-end verification](08-verification-and-documentation.md) | 5 | G | Not started |
| | **Total** | **55** | | |

## Settled Requirements

- Support JavaScript, .NET, Python, Java, Rust, Go, Unity, Godot, and Unreal Engine, including all format variants listed in the phase documents.
- Keep repository layout (`default`, `mono`, `meta`) separate from ecosystem. Detect and configure the umbrella and each app independently.
- Prefer explicit configuration over automatic detection. Resolve ambiguous sources interactively and save the choice in `.xeploy.json`; without an interactive terminal, provide an actionable error.
- Use `VERSION` when an umbrella or app has no recognized version source. Initialize from the latest applicable project/module tag; otherwise prompt with `0.1.0` as the default. Allow a configured initial version for unattended use.
- Preserve canonical release identity, such as `1.2.3-rc.2`, while translating ecosystem and platform representations.
- Support Android version names/codes, Apple marketing/build versions, Windows/.NET numeric versions, and engine package/plugin versions and counters.
- Advance each project's applicable counters once per new RC or final release. Environments sharing a release reuse those values; republishing preserves them. RC-to-final promotion is a new release.
- Keep build counters independent even when release versions are unified. Validate native formats and bounds; preserve platform offsets.
- Work through file parsing and edits without running target-language SDKs, build scripts, interpreters, or engines. Resolve recognized backing files for computed versions; stop for unresolved sources instead of creating a disconnected fallback.
- Create Go-compatible module tags when enabled; stop before any required module/import-path migration.
- Preserve existing JavaScript configuration, release arguments, project selection, and release behavior.

## Planned Design

Use ecosystem adapters to detect projects, read versions, validate targets, and prepare edits. Keep Git and GitHub operations in orchestration. Prepare all selected edits and detect shared-source conflicts before release mutations.

Add a small tracked release-state record per Git repository, committed with version updates, to recognize retries when native fields cannot encode the canonical identity, including `create_tag: false`. Phase A defines its schema and filename; discovery must not write it.

For monorepos, retain the umbrella GitHub release and add applicable Go module tags. Meta-repositories retain serial child releases followed by the umbrella. Do not claim remote operations are atomic; report partial completion accurately.

## Maintaining This Tracker

- Use `Not started`, `In progress`, `Blocked`, or `Complete` for phase status.
- Keep each phase's status and this table synchronized. Record concrete blockers in the phase file.
- Check tasks and acceptance criteria only when verified; add validation evidence and relevant commit references to that phase's implementation record.
- Mark a phase complete only when its acceptance criteria pass and its documentation is current.
- Preserve approved scope when implementation details change; record material plan changes here before proceeding.

## Definition of Done

- [ ] Every phase is complete with acceptance evidence.
- [ ] Existing JavaScript tests and new adapter/mixed-repository tests pass.
- [ ] SDK-free behavior, counters, promotion, retries, and Go migration stops are verified.
- [ ] README and AGENTS.md describe implemented behavior accurately.
- [ ] `bun run test`, `bun run typecheck`, `bun run lint`, and `bun run build` pass.
- [ ] `node dist/cli.js --version` passes after building.

## Plan History

- Initial draft stored as eight phases. All phases remain not started; no application implementation changes accompany this plan.
