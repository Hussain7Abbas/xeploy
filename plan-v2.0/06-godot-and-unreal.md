# Phase F: Godot and Unreal Adapters

[Main tracker](main.md)

- Status: Not started
- Estimate: 8 points
- Depends on: [Phase A](01-project-model.md)

## Outcome

As a Godot or Unreal maintainer, I can release games and addons/plugins with valid application and platform versions without installing either engine.

## Godot Tasks

- [ ] Detect game projects and explicitly configured addon targets independently.
- [ ] Support application version in `project.godot` and addon versions in `plugin.cfg`.
- [ ] Support platform versions in `export_presets.cfg`: Android names/codes, Apple marketing/build versions, and Windows file/product versions.
- [ ] Respect per-preset settings and source precedence. Where inherited values cannot represent a valid platform version, prepare an explicit compatible override in the applicable existing preset.
- [ ] Preserve section boundaries, preset identities, quoting, and unrelated export settings.
- [ ] Exclude `.godot`, generated C# projects, imported resources, and export output from project discovery.

## Unreal Tasks

- [ ] Detect games using `.uproject` identity and plugins using `.uplugin` descriptors.
- [ ] Support game project versions in recognized configuration sections and plugin `VersionName`/numeric `Version` fields.
- [ ] Support applicable Android version names/store counters, Apple marketing/build fields or recognized configuration overrides, and Windows numeric version mappings.
- [ ] Preserve architecture-specific store-version offsets and engine/schema compatibility fields.
- [ ] Confirm writable configuration mappings against representative fixtures; do not invent unsupported keys or edit generated packaged output.
- [ ] Exclude `Intermediate`, `Binaries`, `DerivedDataCache`, and generated projects from discovery.

## Shared Tasks

- [ ] Use targeted edits that preserve comments, formatting, section ownership, and unrelated settings.
- [ ] Apply canonical-to-native mappings and per-project counter policies from Phase A.
- [ ] Validate native formats and counter bounds before release mutations. Explain unresolved overrides or computed build metadata without running an engine.

## Acceptance Criteria

- [ ] Godot games/addons and Unreal games/plugins have version-update fixtures.
- [ ] All listed platform field families are covered where applicable, including multiple presets and platform overrides.
- [ ] Numeric-only fields remain valid for RC and final releases.
- [ ] Engine compatibility settings, platform offsets, and unrelated metadata remain intact.
- [ ] Generated files are excluded and neither engine is executed.
- [ ] Ambiguous or unsupported mappings stop before changes are applied.

## References

- [Godot Android export fields](https://docs.godotengine.org/en/stable/classes/class_editorexportplatformandroid.html)
- [Godot iOS export fields](https://docs.godotengine.org/en/stable/classes/class_editorexportplatformios.html)
- [Godot macOS export fields](https://docs.godotengine.org/en/stable/classes/class_editorexportplatformmacos.html)
- [Godot Windows export fields](https://docs.godotengine.org/en/stable/classes/class_editorexportplatformwindows.html)
- [Unreal plugin descriptor fields](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Projects/FPluginDescriptor)
- [Unreal Android settings](https://dev.epicgames.com/documentation/unreal-engine/android-settings-in-the-unreal-engine-project-settings)
- [Unreal iOS settings](https://dev.epicgames.com/documentation/en-us/unreal-engine/ios-settings-in-the-unreal-engine-project-settings)

## Implementation Record

- Changes: None.
- Validation: Not run; planning only.
- Blockers: None recorded.
