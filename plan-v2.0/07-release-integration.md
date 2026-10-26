# Phase G: Release-Flow Integration

[Main tracker](main.md)

- Status: Complete
- Estimate: 8 points
- Depends on: [B](02-discovery-and-version-fallback.md), [C](03-dotnet-and-python.md), [D](04-java-rust-and-go.md), [E](05-unity.md), [F](06-godot-and-unreal.md)

## Outcome

As a release maintainer, I can release selected mixed-language projects independently or with unified versions through existing CLI workflows.

## Planning and Preflight Tasks

- [x] Replace package-specific version gathering and per-file overrides with project descriptors and adapter results.
- [x] Normalize versions before comparison and unification; preserve independent targets for each selected project.
- [x] Build a complete edit/tag plan covering RC and final tiers, platform values, new `VERSION` files, and release-state updates.
- [x] Resolve shared-source consumers. Deduplicate identical edits and reject conflicting versions or updates that would affect unselected projects.
- [x] Preflight all selected repositories before release mutations, including meta children, rather than discovering invalid sources after earlier releases have completed.
- [x] Preview project identities, sources, canonical/native targets, counters, files, tags, and applicable Go migration errors.

## Execution Tasks

- [x] Apply validated edits only after existing release confirmation. Recheck expected file contents before writing and stage only intended paths.
- [x] Restore affected local files if applying a batch fails before commit; do not promise rollback of completed remote operations.
- [x] Commit version files and release-state updates together. Recognize retries and avoid repeating completed counter increments, including `create_tag: false`.
- [x] Advance counters once per new RC/final tier, reuse them across environments sharing a tier, preserve them on republish, and increment on RC-to-final promotion.
- [x] Preserve serial meta child releases followed by umbrella handling and submodule-pointer updates; report partial completion and recovery details accurately.
- [x] Retain monorepo umbrella GitHub releases and create applicable Go module tags at the relevant release commit. Respect tag disabling and detect tag collisions.
- [x] Scope Go tag discovery, release targets, and notes boundaries without mixing unrelated module versions into comparisons.

## Workflow and Compatibility Tasks

- [x] Integrate adapters into new releases, explicit version/bump arguments, independent/unified versions, RC promotion, and old-release republishing.
- [x] Preserve existing `--rc`, `--hotfix`, `--minor`, `--major`, environment selection, and `--unify` behavior.
- [x] Update configuration-editor prompts and summaries that currently say package.json is the only version source.
- [x] Ensure malformed configured sources fail instead of being silently skipped.

## Acceptance Criteria

- [x] Mixed mono and meta fixtures pass in independent and unified modes with differently typed umbrellas.
- [x] Selecting only a subset leaves unselected versions unchanged; shared-source conflicts stop before release mutations.
- [x] An invalid child prevents earlier repositories from starting a release.
- [x] Retries, republishing, promotion, and multi-environment releases produce the expected counters and state.
- [x] Go module tags point at the correct commit, and import-path migration requirements stop the plan.
- [x] Existing JavaScript release tests remain passing.

## Likely Code Areas

`src/flows.ts`, `src/meta.ts`, `src/versions.ts`, `src/config.ts`, `src/config-editor.ts`, `src/cli-options.ts`, `src/git.ts`, and `src/index.ts`.

## Implementation Record

- Changes: CLI and public entry points prepare complete native RC/final graphs before confirmation. Frozen edits, canonical state, Go tags, subsets and shared declaration ownership are integrated with serial child/umbrella execution. `--resume` persists the approved graph and completed steps under Git metadata; version commits, branch pushes, GitHub operations and environment sync are individually resumable.
- Validation: Mixed VERSION/Python/Flutter mono and .NET/Flutter plus Python/Go meta fixtures pass, including independent/unified versions, actual submodule paths, subsets, detached children, invalid-child preflight, selected shared declarations and separate fields in shared files. Historical promotion inspects RC trees/gitlinks, excludes newer work, increments old counters and restores branches. Historical root/child republishing preserves source files and annotated tag objects; unchanged final children do not enter promotion. Rejected release/environment/production-branch pushes, partial child releases, and unknown GitHub creation outcomes are retried successfully with unchanged counter identities. Public preflight and cancellation, existing-tag collisions and Go migration stops pass.
- TDD evidence: Observed RED → GREEN for public preflight ordering, unrelated unresolved subsets (including umbrella updates), independent mixed-meta paths, detached-child pushes, shared platform ownership, swallowed production branch failures, canonical-state conflicts, and remote push recovery. Existing passing fixtures are coverage, not claimed red cycles.
- Limits: SDK/engine execution and package publication remain outside scope. Remote operations are non-atomic; resume stops for unexpected user edits or changed branch/HEAD expectations. Unknown engine/import/computed layouts require explicit literal source configuration rather than runtime evaluation.
- Blockers: None.
