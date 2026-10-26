# Phase D: Java, Rust, and Go Adapters

[Main tracker](main.md)

- Status: Complete
- Estimate: 8 points
- Depends on: [Phase A](01-project-model.md)

## Outcome

As a Java, Rust, or Go maintainer, I can plan native version updates and compatible tags without installing language tooling or changing application imports.

## Java Tasks

- [x] Support Maven `pom.xml` project versions, recognized parent inheritance, and property-backed versions, including CI-friendly revision properties.
- [x] Resolve authoritative declarations without rewriting unrelated parent or dependency versions.
- [x] Support Gradle Groovy and Kotlin scripts with statically identifiable literal versions, plus recognized bindings to `gradle.properties`.
- [x] Resolve supported property references and stop for arbitrary computed versions rather than executing Gradle or Maven.
- [x] Record shared-source ownership and preserve XML/script/property-file formatting.

## Rust Tasks

- [x] Support `[package].version` in `Cargo.toml`.
- [x] Resolve workspace-inherited versions to `[workspace.package].version` and identify affected members.
- [x] Report conflicts when independent targets share the same version declaration or when a selected update affects unselected consumers.
- [x] Define and test narrowly scoped synchronization of local package version metadata in an existing `Cargo.lock`, without invoking Cargo or resolving dependencies. Stop if required synchronization cannot be represented safely.

## Go Tasks

- [x] Detect module identity using `go.mod`; use `VERSION` for local project version tracking rather than treating dependency or Go toolchain versions as the module's own version.
- [x] Derive module-compatible `v` tags and subdirectory prefixes, accounting for major-version directory layouts.
- [x] Scope tag lookup and latest-version detection to the relevant module.
- [x] Detect target major versions requiring module/import-path migration. Stop before edits, commits, tags, or releases and describe the required manual work.
- [x] Prepare required module tags for integration in Phase G; respect `create_tag: false` and detect collisions.

## Acceptance Criteria

- [x] Maven, both Gradle script variants, Rust package/workspace versions, and Go `VERSION` sources have fixture coverage.
- [x] Native values normalize correctly for independent and unified release plans.
- [x] No JVM, Cargo, Go, or build scripts are executed.
- [x] Shared declarations are updated once or rejected when requested versions conflict.
- [x] Go nested-module tags are correct, and migration-required targets fail before mutations.
- [x] Formatting and unrelated dependency declarations remain intact.

## References

- [Maven CI-friendly versions](https://maven.apache.org/guides/mini/guide-maven-ci-friendly.html)
- [Gradle property configuration](https://docs.gradle.org/current/userguide/build_environment.html)
- [Cargo workspace inheritance](https://doc.rust-lang.org/cargo/reference/workspaces.html)
- [Go module versions and tags](https://go.dev/ref/mod#versions)
- [Go module source layouts](https://go.dev/doc/modules/managing-source)

## Implementation Record

- Changes: Added Maven local-parent/property sources, Gradle literals/properties, Cargo workspace ownership and narrow local lockfile edits, Go VERSION sources, module tags, and migration preflight.
- Validation: Observed Java/Rust/Go RED/GREEN. Maven parent binding and local Cargo.lock regressions pass. Local bare-remote Go tag identity/collision checks and migration-before-commit tests pass. Shared-workspace batching, registry-only lock references, SNAPSHOT baselines, split revision/changelist backing files, Maven CLI property overrides, Kotlin property bindings, computed Gradle rejection, and Go module-scoped VERSION initialization pass.
- Blockers: None recorded.
