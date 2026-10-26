# Phase B: Discovery, Overrides, and VERSION

[Main tracker](main.md)

- Status: Complete
- Estimate: 8 points
- Depends on: [Phase A](01-project-model.md)

## Outcome

As a release maintainer, I can discover mixed projects and configure a useful version source for every umbrella or app, including projects without manifests.

## Tasks

- [x] Replace package-count-based layout inference with ecosystem-aware discovery, retaining explicit layout and project settings as authoritative.
- [x] Resolve umbrella and child projects independently. Use actual submodule paths, not assumptions that submodule names equal directory names.
- [x] Support explicit project paths and existing `subprojectsDir` configurations. Do not impose one ecosystem on a shared parent directory.
- [x] Exclude dependencies, build output, engine caches, generated projects, and unrelated manifests from project discovery.
- [x] Group files belonging to one project; engine-generated `.csproj` files and dependency manifests must not become extra release projects.
- [x] Prompt when authoritative sources are ambiguous, persist the selection in `.xeploy.json`, and honor it on subsequent runs.
- [x] Return actionable errors for unresolved choices when no interactive terminal is available.
- [x] Add a plain-text `VERSION` adapter for existing files and planned file creation when no recognized version source exists.
- [x] Initialize a missing fallback from the latest applicable project/module tag. Otherwise prompt for a starting version with `0.1.0` offered; permit a configured initial version for unattended use.
- [x] Show initialization and subsequent target versions explicitly in the preview, preserving existing bump semantics.
- [x] Distinguish absent sources from malformed, ambiguous, or computed sources. Do not silently bypass a broken source with `VERSION`.
- [x] Validate repository boundaries, including resolved paths, and keep discovery read-only.

## Likely Code Areas

- `src/discover.ts` and discovery currently embedded in `src/config.ts`.
- `src/config-editor.ts`: project/source selection and persisted overrides.
- New fallback-version and discovery tests under `tests/`.

## Acceptance Criteria

- [x] A manifestless umbrella with Python, .NET, Godot, and Go children is discoverable.
- [x] A meta-repository recognizes different child ecosystems at their actual Git submodule paths.
- [x] Missing umbrella and child version sources can each use their own `VERSION` file.
- [x] Source overrides survive configuration reloads; ambiguous noninteractive runs do not guess.
- [x] Discovery creates no version/state files and does not execute target tooling.
- [x] Generated engine files and dependencies are excluded, and out-of-repository paths are rejected.

## Implementation Record

- Changes: Added mixed discovery, engine/cache exclusions, shared/container-independent paths, source ambiguity errors and interactive selection, initial-version setup, explicit overrides, and VERSION fallback.
- Validation: Discovery RED/GREEN covers manifestless mono, engine umbrellas, and multiple containers. Generic creation and path-boundary tests pass. Interactive source persistence, noninteractive missing-baseline rejection, and tag-based initialization now have passing acceptance tests. Version paths reject symlink aliases as well as escapes.
- Blockers: None recorded.
