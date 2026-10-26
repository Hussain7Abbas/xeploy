# Phase F: Godot and Unreal Adapters

[Main tracker](main.md)

- Status: Complete
- Estimate: 8 points
- Depends on: [Phase A](01-project-model.md)

## Outcome

As a Godot or Unreal maintainer, I can release games and addons/plugins with valid application and platform versions without installing either engine.

## Godot Tasks

- [x] Detect game projects and explicitly configured addon targets independently.
- [x] Support application version in `project.godot` and addon versions in `plugin.cfg`.
- [x] Support platform versions in `export_presets.cfg`: Android names/codes, Apple marketing/build versions, and Windows file/product versions.
- [x] Respect per-preset settings and source precedence. Where inherited values cannot represent a valid platform version, prepare an explicit compatible override in the applicable existing preset.
- [x] Preserve section boundaries, preset identities, quoting, and unrelated export settings.
- [x] Exclude `.godot`, generated C# projects, imported resources, and export output from project discovery.

## Unreal Tasks

- [x] Detect games using `.uproject` identity and plugins using `.uplugin` descriptors.
- [x] Support game project versions in recognized configuration sections and plugin `VersionName`/numeric `Version` fields.
- [x] Support applicable Android version names/store counters, Apple marketing/build fields or recognized configuration overrides, and Windows numeric version mappings.
- [x] Preserve architecture-specific store-version offsets and engine/schema compatibility fields.
- [x] Confirm writable configuration mappings against representative fixtures; do not invent unsupported keys or edit generated packaged output.
- [x] Exclude `Intermediate`, `Binaries`, `DerivedDataCache`, and generated projects from discovery.

## Shared Tasks

- [x] Use targeted edits that preserve comments, formatting, section ownership, and unrelated settings.
- [x] Apply canonical-to-native mappings and per-project counter policies from Phase A.
- [x] Validate native formats and counter bounds before release mutations. Explain unresolved overrides or computed build metadata without running an engine.

## Acceptance Criteria

- [x] Godot games/addons and Unreal games/plugins have version-update fixtures.
- [x] All listed platform field families are covered where applicable, including multiple presets and platform overrides.
- [x] Numeric-only fields remain valid for RC and final releases.
- [x] Engine compatibility settings, platform offsets, and unrelated metadata remain intact.
- [x] Generated files are excluded and neither engine is executed.
- [x] Ambiguous or unsupported mappings stop before changes are applied.

## References

- [Godot Android export fields](https://docs.godotengine.org/en/stable/classes/class_editorexportplatformandroid.html)
- [Godot iOS export fields](https://docs.godotengine.org/en/stable/classes/class_editorexportplatformios.html)
- [Godot macOS export fields](https://docs.godotengine.org/en/stable/classes/class_editorexportplatformmacos.html)
- [Godot Windows export fields](https://docs.godotengine.org/en/stable/classes/class_editorexportplatformwindows.html)
- [Unreal plugin descriptor fields](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Projects/FPluginDescriptor)
- [Unreal Android settings](https://dev.epicgames.com/documentation/unreal-engine/android-settings-in-the-unreal-engine-project-settings)
- [Unreal iOS settings](https://dev.epicgames.com/documentation/en-us/unreal-engine/ios-settings-in-the-unreal-engine-project-settings)

## Implementation Record

- Changes: Added Godot game/addon and export-preset mappings; Unreal game/plugin, Android and Apple marketing-version mappings. Explicit platform_fields bindings support source JSON, INI, YAML, XML and plist values.
- Validation: Observed Godot/Unreal adapter RED/GREEN. Android and Apple preset fields and plugin counters pass; compatibility and architecture offsets remain unchanged. Missing Godot Windows overrides, blank Apple defaults, Unreal numeric Windows/explicit Apple builds, Android offset bounds, and Unity layout/CRLF/VisionOS checks pass.
- Blockers: None recorded.
