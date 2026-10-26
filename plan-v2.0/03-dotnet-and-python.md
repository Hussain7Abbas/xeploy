# Phase C: .NET and Python Adapters

[Main tracker](main.md)

- Status: Complete
- Estimate: 8 points
- Depends on: [Phase A](01-project-model.md)

## Outcome

As a .NET or Python maintainer, I can bump recognized project versions and relevant platform metadata without installing SDKs or running project code.

## .NET Tasks

- [x] Read and update versions in `.csproj`, `.fsproj`, and shared `Directory.Build.props`.
- [x] Support literal `Version`, `VersionPrefix`/`VersionSuffix`, and `PackageVersion` properties, distinguishing project versions from dependency declarations.
- [x] Support assembly, file, and informational versions plus applicable application display/build properties, including existing MAUI-style configuration.
- [x] Map numeric-only properties separately from the canonical prerelease identity; validate each field's format and limits.
- [x] Resolve recognized shared properties and backing files without evaluating MSBuild. Report ambiguous conditions/imports or unsupported expressions with explicit configuration guidance.
- [x] Preserve inherited ownership and identify consumers for shared-source conflict checks.

## Python Tasks

- [x] Support standard `[project].version` and Poetry version settings in `pyproject.toml`.
- [x] Support `setup.cfg` and statically identifiable literal version declarations in `setup.py`.
- [x] Resolve recognized dynamic version sources backed by files or literal attributes; account for explicitly recognized Git-derived version providers without executing them.
- [x] Normalize supported Python versions to canonical release identity and emit native RC formatting, such as `1.2.3rc2`.
- [x] Stop with source-selection guidance for arbitrary computed versions. Do not insert a static version alongside a dynamic declaration or create a disconnected `VERSION` fallback.

## Shared Tasks

- [x] Prepare minimal edits preserving comments, indentation, line endings, and unrelated content.
- [x] Add fixtures for shared versions, source precedence, prereleases, malformed declarations, conflicting values, and unsupported expressions.
- [x] Add fixtures proving source files are inspected without executing Python or .NET tooling.

## Acceptance Criteria

- [x] Supported .NET and Python formats round-trip with only intended version fields changed.
- [x] Canonically equivalent native versions compare equally during unification.
- [x] Shared-source ownership is reported accurately; dependency versions remain untouched unless they are recognized version bindings.
- [x] Unresolvable computed or conditional sources produce actionable errors without writes.
- [x] Numeric platform values remain valid for RC and final releases.

## References

- [.NET versioning](https://learn.microsoft.com/en-gb/dotnet/standard/library-guidance/versioning)
- [MSBuild package version properties](https://learn.microsoft.com/en-us/nuget/reference/msbuild-targets)
- [Python static and dynamic metadata](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/#static-vs-dynamic-metadata)
- [Python version specification](https://packaging.python.org/en/latest/specifications/version-specifiers/)
- [setuptools setup.cfg configuration](https://setuptools.pypa.io/en/latest/userguide/declarative_config.html)

## Implementation Record

- Changes: Added static .NET XML and shared props, native numeric/application fields; Python standard/Poetry/setuptools metadata, static setup.py, file/attribute providers, and RC conversion.
- Validation: Observed .NET and Python adapter RED/GREEN; shared props, platform numeric values, duplicate Python metadata synchronization, static attribute/file providers, and format fixtures pass. MAUI display/build-only versions and computed setup.py rejection also have acceptance coverage. Additional acceptance covers local-over-shared precedence, separate RC suffix insertion, static MSBuild property references/cycles, malformed XML, conflicting metadata, typed module constants, setuptools file arrays, and root/meta Python SCM providers. Further regressions cover inherited numeric platform fields with local overrides, unknown imports, self-closing literal guidance, and SCM tags on unrelated branches. Unknown/customized or nested SCM providers require an explicit literal backend; no provider code is evaluated.
- Blockers: None recorded.
