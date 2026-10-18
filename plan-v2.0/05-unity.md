# Phase E: Unity Adapter

[Main tracker](main.md)

- Status: Not started
- Estimate: 5 points
- Depends on: [Phase A](01-project-model.md)

## Outcome

As a Unity maintainer, I can release games and reusable packages with human-readable and applicable platform versions without opening Unity.

## Tasks

- [ ] Detect Unity games from recognized project markers and reusable packages from Unity package metadata.
- [ ] Read and prepare game version edits in `ProjectSettings/ProjectSettings.asset`, including the serialized application/bundle version.
- [ ] Support Android version codes, Apple build numbers, and applicable Windows numeric version settings represented in recognized project schemas.
- [ ] Support reusable package versions in `package.json`, retaining JavaScript adapter compatibility where the manifest format overlaps.
- [ ] Keep Unity engine/editor compatibility versions and dependency declarations separate from release versions.
- [ ] Recognize supported serialized settings layouts and validate field mappings against fixtures before writing. Require explicit guidance for unknown or ambiguous layouts.
- [ ] Preserve Unity YAML structure, tags, comments, line endings, and unrelated settings through targeted edits.
- [ ] Exclude generated `.csproj` files, `Library`, `Temp`, and build output from project discovery.
- [ ] Emit platform-valid values for prereleases while retaining canonical release identity through the common state model.
- [ ] Prepare counter changes once per new canonical release, preserving values on republish and respecting native bounds.

## Acceptance Criteria

- [ ] Unity game and package fixtures receive only intended version updates.
- [ ] Android, Apple, and applicable Windows version mappings are covered by fixtures.
- [ ] Generated C# projects do not become additional .NET release targets.
- [ ] Neither Unity nor .NET tooling is required or executed.
- [ ] Shared-release environments reuse counter values; RC-to-final targets prepare a new increment.
- [ ] Unsupported settings layouts fail with an actionable error before writes.

## References

- [Unity application version and platform fields](https://docs.unity.com/en-us/engine/6000.0/script-reference/unityeditor/playersettings/bundleversion)
- [Unity Apple build numbers](https://docs.unity3d.com/cn/6000.0/ScriptReference/PlayerSettings.iOS-buildNumber.html)
- [Unity package manifest](https://docs.unity3d.com/6000.0/Documentation/Manual/upm-manifestPkg.html)

## Implementation Record

- Changes: None.
- Validation: Not run; planning only.
- Blockers: None recorded.
