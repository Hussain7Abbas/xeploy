# Phase A: Project Model and Adapter Contract

[Main tracker](main.md)

- Status: Not started
- Estimate: 5 points
- Depends on: None

## Outcome

As a maintainer, I can represent each umbrella and app independently of repository layout, while existing JavaScript configurations continue working.

## Tasks

- [ ] Define a project descriptor with stable identity, path, ecosystem, authoritative version source, additional platform fields, and shared-source ownership.
- [ ] Keep `RepoType` (`default`, `mono`, `meta`) separate from project ecosystem. Add optional umbrella and subproject settings to `.xeploy.json`.
- [ ] Preserve existing configuration defaults and support explicit per-project overrides without inheriting the umbrella's language accidentally.
- [ ] Define an adapter contract for detection, source resolution, reading, canonical normalization, target validation, and preparation of edits.
- [ ] Keep adapters free of Git/GitHub mutations. Return planned changes rather than writing during detection or planning.
- [ ] Define canonical release identity and native version/counter mappings, including numeric-only representations and ecosystem-specific RC forms.
- [ ] Define a small tracked release-state record per Git repository: filename, schema, per-project release identity, counter values, and compatibility behavior. Commit it with version edits; use it to recognize retries even with `create_tag: false`.
- [ ] Define a common edit representation that supports expected original content, new files, exact changed paths, and shared-source conflict detection.
- [ ] Preserve current public JavaScript helpers where feasible and document any necessary API compatibility changes.

## Likely Code Areas

- `src/config.ts`: configuration types, normalization, and validation.
- `src/versions.ts`: existing JSON-only readers and writers.
- `src/semver.ts`: canonical comparison and formatting.
- New project/adapter modules under `src/`; exports in `src/index.ts`.

## Acceptance Criteria

- [ ] Existing JavaScript configurations normalize without requiring new fields or changing behavior.
- [ ] A root .NET project and Python, Unity, and Go children can all be represented in one configuration.
- [ ] An adapter can prepare edits without modifying files or executing project tooling.
- [ ] Canonical versions remain comparable across native representations.
- [ ] Release-state identity is scoped by Git repository and project, with no writes during discovery.

## Implementation Record

- Changes: None.
- Validation: Not run; planning only.
- Blockers: None recorded.
