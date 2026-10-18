# Phase G: Release-Flow Integration

[Main tracker](main.md)

- Status: Not started
- Estimate: 8 points
- Depends on: [B](02-discovery-and-version-fallback.md), [C](03-dotnet-and-python.md), [D](04-java-rust-and-go.md), [E](05-unity.md), [F](06-godot-and-unreal.md)

## Outcome

As a release maintainer, I can release selected mixed-language projects independently or with unified versions through existing CLI workflows.

## Planning and Preflight Tasks

- [ ] Replace package-specific version gathering and per-file overrides with project descriptors and adapter results.
- [ ] Normalize versions before comparison and unification; preserve independent targets for each selected project.
- [ ] Build a complete edit/tag plan covering RC and final tiers, platform values, new `VERSION` files, and release-state updates.
- [ ] Resolve shared-source consumers. Deduplicate identical edits and reject conflicting versions or updates that would affect unselected projects.
- [ ] Preflight all selected repositories before release mutations, including meta children, rather than discovering invalid sources after earlier releases have completed.
- [ ] Preview project identities, sources, canonical/native targets, counters, files, tags, and applicable Go migration errors.

## Execution Tasks

- [ ] Apply validated edits only after existing release confirmation. Recheck expected file contents before writing and stage only intended paths.
- [ ] Restore affected local files if applying a batch fails before commit; do not promise rollback of completed remote operations.
- [ ] Commit version files and release-state updates together. Recognize retries and avoid repeating completed counter increments, including `create_tag: false`.
- [ ] Advance counters once per new RC/final tier, reuse them across environments sharing a tier, preserve them on republish, and increment on RC-to-final promotion.
- [ ] Preserve serial meta child releases followed by umbrella handling and submodule-pointer updates; report partial completion and recovery details accurately.
- [ ] Retain monorepo umbrella GitHub releases and create applicable Go module tags at the relevant release commit. Respect tag disabling and detect tag collisions.
- [ ] Scope Go tag discovery, release targets, and notes boundaries without mixing unrelated module versions into comparisons.

## Workflow and Compatibility Tasks

- [ ] Integrate adapters into new releases, explicit version/bump arguments, independent/unified versions, RC promotion, and old-release republishing.
- [ ] Preserve existing `--rc`, `--hotfix`, `--minor`, `--major`, environment selection, and `--unify` behavior.
- [ ] Update configuration-editor prompts and summaries that currently say package.json is the only version source.
- [ ] Ensure malformed configured sources fail instead of being silently skipped.

## Acceptance Criteria

- [ ] Mixed mono and meta fixtures pass in independent and unified modes with differently typed umbrellas.
- [ ] Selecting only a subset leaves unselected versions unchanged; shared-source conflicts stop before release mutations.
- [ ] An invalid child prevents earlier repositories from starting a release.
- [ ] Retries, republishing, promotion, and multi-environment releases produce the expected counters and state.
- [ ] Go module tags point at the correct commit, and import-path migration requirements stop the plan.
- [ ] Existing JavaScript release tests remain passing.

## Likely Code Areas

`src/flows.ts`, `src/meta.ts`, `src/versions.ts`, `src/config.ts`, `src/config-editor.ts`, `src/cli-options.ts`, `src/git.ts`, and `src/index.ts`.

## Implementation Record

- Changes: None.
- Validation: Not run; planning only.
- Blockers: None recorded.
