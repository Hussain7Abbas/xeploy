# Phase C: .NET and Python Adapters

[Main tracker](main.md)

- Status: Not started
- Estimate: 8 points
- Depends on: [Phase A](01-project-model.md)

## Outcome

As a .NET or Python maintainer, I can bump recognized project versions and relevant platform metadata without installing SDKs or running project code.

## .NET Tasks

- [ ] Read and update versions in `.csproj`, `.fsproj`, and shared `Directory.Build.props`.
- [ ] Support literal `Version`, `VersionPrefix`/`VersionSuffix`, and `PackageVersion` properties, distinguishing project versions from dependency declarations.
- [ ] Support assembly, file, and informational versions plus applicable application display/build properties, including existing MAUI-style configuration.
- [ ] Map numeric-only properties separately from the canonical prerelease identity; validate each field's format and limits.
- [ ] Resolve recognized shared properties and backing files without evaluating MSBuild. Report ambiguous conditions/imports or unsupported expressions with explicit configuration guidance.
- [ ] Preserve inherited ownership and identify consumers for shared-source conflict checks.

## Python Tasks

- [ ] Support standard `[project].version` and Poetry version settings in `pyproject.toml`.
- [ ] Support `setup.cfg` and statically identifiable literal version declarations in `setup.py`.
- [ ] Resolve recognized dynamic version sources backed by files or literal attributes; account for explicitly recognized Git-derived version providers without executing them.
- [ ] Normalize supported Python versions to canonical release identity and emit native RC formatting, such as `1.2.3rc2`.
- [ ] Stop with source-selection guidance for arbitrary computed versions. Do not insert a static version alongside a dynamic declaration or create a disconnected `VERSION` fallback.

## Shared Tasks

- [ ] Prepare minimal edits preserving comments, indentation, line endings, and unrelated content.
- [ ] Add fixtures for shared versions, source precedence, prereleases, malformed declarations, conflicting values, and unsupported expressions.
- [ ] Add fixtures proving source files are inspected without executing Python or .NET tooling.

## Acceptance Criteria

- [ ] Supported .NET and Python formats round-trip with only intended version fields changed.
- [ ] Canonically equivalent native versions compare equally during unification.
- [ ] Shared-source ownership is reported accurately; dependency versions remain untouched unless they are recognized version bindings.
- [ ] Unresolvable computed or conditional sources produce actionable errors without writes.
- [ ] Numeric platform values remain valid for RC and final releases.

## References

- [.NET versioning](https://learn.microsoft.com/en-gb/dotnet/standard/library-guidance/versioning)
- [MSBuild package version properties](https://learn.microsoft.com/en-us/nuget/reference/msbuild-targets)
- [Python static and dynamic metadata](https://packaging.python.org/en/latest/guides/writing-pyproject-toml/#static-vs-dynamic-metadata)
- [Python version specification](https://packaging.python.org/en/latest/specifications/version-specifiers/)
- [setuptools setup.cfg configuration](https://setuptools.pypa.io/en/latest/userguide/declarative_config.html)

## Implementation Record

- Changes: None.
- Validation: Not run; planning only.
- Blockers: None recorded.
