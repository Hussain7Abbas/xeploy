# Phase E: Unity and Flutter Adapters

[Main tracker](main.md)

- Status: Complete
- Estimate: 8 points
- Depends on: [Phase A](01-project-model.md)

## Outcome

As a Unity maintainer, I can release games and reusable packages with human-readable and applicable platform versions without opening Unity.

## Tasks

- [x] Detect Unity games from recognized project markers and reusable packages from Unity package metadata.
- [x] Read and prepare game version edits in `ProjectSettings/ProjectSettings.asset`, including the serialized application/bundle version.
- [x] Support Android version codes, Apple build numbers, and applicable Windows numeric version settings represented in recognized project schemas.
- [x] Support reusable package versions in `package.json`, retaining JavaScript adapter compatibility where the manifest format overlaps.
- [x] Keep Unity engine/editor compatibility versions and dependency declarations separate from release versions.
- [x] Recognize supported serialized settings layouts and validate field mappings against fixtures before writing. Require explicit guidance for unknown or ambiguous layouts.
- [x] Preserve Unity YAML structure, tags, comments, line endings, and unrelated settings through targeted edits.
- [x] Exclude generated `.csproj` files, `Library`, `Temp`, and build output from project discovery.
- [x] Emit platform-valid values for prereleases while retaining canonical release identity through the common state model.
- [x] Prepare counter changes once per new canonical release, preserving values on republish and respecting native bounds.

## Flutter Tasks

- [x] Detect Flutter applications and Dart/Flutter packages through `pubspec.yaml`.
- [x] Read release identity and numeric build metadata separately; increment build counters once per new canonical release.
- [x] Preserve YAML comments, quoting, line endings, and nested dependency versions.
- [x] Support platform values through the authoritative pubspec and recognized explicit overrides; preserve generated files.
- [x] Use valid numeric platform mappings where prerelease suffixes are unsupported, preserving canonical identity in release state.
- [x] Work without Dart, Flutter, or platform SDKs.

## Acceptance Criteria

- [x] Flutter/pubspec fixtures cover prereleases, counters, missing/malformed versions, comments, and platform representations.
- [x] Flutter works as umbrella or child in mixed mono/meta repositories.

- [x] Unity game and package fixtures receive only intended version updates.
- [x] Android, Apple, and applicable Windows version mappings are covered by fixtures.
- [x] Generated C# projects do not become additional .NET release targets.
- [x] Neither Unity nor .NET tooling is required or executed.
- [x] Shared-release environments reuse counter values; RC-to-final targets prepare a new increment.
- [x] Unsupported settings layouts fail with an actionable error before writes.

## References

- [Unity application version and platform fields](https://docs.unity.com/en-us/engine/6000.0/script-reference/unityeditor/playersettings/bundleversion)
- [Unity Apple build numbers](https://docs.unity3d.com/cn/6000.0/ScriptReference/PlayerSettings.iOS-buildNumber.html)
- [Unity package manifest](https://docs.unity3d.com/6000.0/Documentation/Manual/upm-manifestPkg.html)

## Implementation Record

- Changes: Added Unity game/package sources, Android/Apple counters, numeric game version with canonical release state; Flutter pubspec versions, counters, numeric platform build names, and Apple plist bindings.
- Validation: Unity and Flutter fixtures pass, including retry preservation, numeric Apple RC identity, explicit Unity packages, and two-tier mixed meta releases. Native bounds, literal plist/JSON overrides, large Apple counters, and default Unity version normalization also pass. Commented plist fields, SDK placeholders, malformed/missing pubspec values, CRLF VisionOS/Standalone counters, numeric Windows bounds, unknown PlayerSettings layouts, and historical/remote retry counters are covered. Support is limited to documented recognized fields and explicit source overrides; no engine is run.
- Blockers: None recorded.
