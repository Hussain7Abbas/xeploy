# Phase A: Project Model and Adapter Contract

[Main tracker](main.md)

- Status: Complete
- Estimate: 5 points
- Depends on: None

## Outcome

As a maintainer, I can represent each umbrella and app independently of repository layout, while existing JavaScript configurations continue working.

## Tasks

- [x] Define a project descriptor with stable identity, path, ecosystem, authoritative version source, additional platform fields, and shared-source ownership.
- [x] Keep `RepoType` (`default`, `mono`, `meta`) separate from project ecosystem. Add optional umbrella and subproject settings to `.xeploy.json`.
- [x] Preserve existing configuration defaults and support explicit per-project overrides without inheriting the umbrella's language accidentally.
- [x] Define an adapter contract for detection, source resolution, reading, canonical normalization, target validation, and preparation of edits.
- [x] Keep adapters free of Git/GitHub mutations. Return planned changes rather than writing during detection or planning.
- [x] Define canonical release identity and native version/counter mappings, including numeric-only representations and ecosystem-specific RC forms.
- [x] Define a small tracked release-state record per Git repository: filename, schema, per-project release identity, counter values, and compatibility behavior. Commit it with version edits; use it to recognize retries even with `create_tag: false`.
- [x] Define a common edit representation that supports expected original content, new files, exact changed paths, and shared-source conflict detection.
- [x] Preserve current public JavaScript helpers where feasible and document any necessary API compatibility changes.

## Likely Code Areas

- `src/config.ts`: configuration types, normalization, and validation.
- `src/versions.ts`: existing JSON-only readers and writers.
- `src/semver.ts`: canonical comparison and formatting.
- New project/adapter modules under `src/`; exports in `src/index.ts`.

## Acceptance Criteria

- [x] Existing JavaScript configurations normalize without requiring new fields or changing behavior.
- [x] A root .NET project and Python, Unity, and Go children can all be represented in one configuration.
- [x] An adapter can prepare edits without modifying files or executing project tooling.
- [x] Canonical versions remain comparable across native representations.
- [x] Release-state identity is scoped by Git repository and project, with no writes during discovery.

## Implementation Record

- Changes: Added project-model.ts, projects.ts, edit batches, public project APIs, and repository-scoped .xeploy-state.json schema 1. Layout and ecosystem are independent; existing JS helpers remain exported.
- Validation: Observed mixed discovery RED (default instead of mono), then GREEN; adapter fixtures and original JS release regressions pass. Flutter/Unity native-to-canonical state and stale-source tests pass.
- Blockers: None recorded.
