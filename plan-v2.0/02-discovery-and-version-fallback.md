# Phase B: Discovery, Overrides, and VERSION

[Main tracker](main.md)

- Status: Not started
- Estimate: 8 points
- Depends on: [Phase A](01-project-model.md)

## Outcome

As a release maintainer, I can discover mixed projects and configure a useful version source for every umbrella or app, including projects without manifests.

## Tasks

- [ ] Replace package-count-based layout inference with ecosystem-aware discovery, retaining explicit layout and project settings as authoritative.
- [ ] Resolve umbrella and child projects independently. Use actual submodule paths, not assumptions that submodule names equal directory names.
- [ ] Support explicit project paths and existing `subprojectsDir` configurations. Do not impose one ecosystem on a shared parent directory.
- [ ] Exclude dependencies, build output, engine caches, generated projects, and unrelated manifests from project discovery.
- [ ] Group files belonging to one project; engine-generated `.csproj` files and dependency manifests must not become extra release projects.
- [ ] Prompt when authoritative sources are ambiguous, persist the selection in `.xeploy.json`, and honor it on subsequent runs.
- [ ] Return actionable errors for unresolved choices when no interactive terminal is available.
- [ ] Add a plain-text `VERSION` adapter for existing files and planned file creation when no recognized version source exists.
- [ ] Initialize a missing fallback from the latest applicable project/module tag. Otherwise prompt for a starting version with `0.1.0` offered; permit a configured initial version for unattended use.
- [ ] Show initialization and subsequent target versions explicitly in the preview, preserving existing bump semantics.
- [ ] Distinguish absent sources from malformed, ambiguous, or computed sources. Do not silently bypass a broken source with `VERSION`.
- [ ] Validate repository boundaries, including resolved paths, and keep discovery read-only.

## Likely Code Areas

- `src/discover.ts` and discovery currently embedded in `src/config.ts`.
- `src/config-editor.ts`: project/source selection and persisted overrides.
- New fallback-version and discovery tests under `tests/`.

## Acceptance Criteria

- [ ] A manifestless umbrella with Python, .NET, Godot, and Go children is discoverable.
- [ ] A meta-repository recognizes different child ecosystems at their actual Git submodule paths.
- [ ] Missing umbrella and child version sources can each use their own `VERSION` file.
- [ ] Source overrides survive configuration reloads; ambiguous noninteractive runs do not guess.
- [ ] Discovery creates no version/state files and does not execute target tooling.
- [ ] Generated engine files and dependencies are excluded, and out-of-repository paths are rejected.

## Implementation Record

- Changes: None.
- Validation: Not run; planning only.
- Blockers: None recorded.
