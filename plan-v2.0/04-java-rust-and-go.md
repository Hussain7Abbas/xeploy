# Phase D: Java, Rust, and Go Adapters

[Main tracker](main.md)

- Status: Not started
- Estimate: 8 points
- Depends on: [Phase A](01-project-model.md)

## Outcome

As a Java, Rust, or Go maintainer, I can plan native version updates and compatible tags without installing language tooling or changing application imports.

## Java Tasks

- [ ] Support Maven `pom.xml` project versions, recognized parent inheritance, and property-backed versions, including CI-friendly revision properties.
- [ ] Resolve authoritative declarations without rewriting unrelated parent or dependency versions.
- [ ] Support Gradle Groovy and Kotlin scripts with statically identifiable literal versions, plus recognized bindings to `gradle.properties`.
- [ ] Resolve supported property references and stop for arbitrary computed versions rather than executing Gradle or Maven.
- [ ] Record shared-source ownership and preserve XML/script/property-file formatting.

## Rust Tasks

- [ ] Support `[package].version` in `Cargo.toml`.
- [ ] Resolve workspace-inherited versions to `[workspace.package].version` and identify affected members.
- [ ] Report conflicts when independent targets share the same version declaration or when a selected update affects unselected consumers.
- [ ] Define and test narrowly scoped synchronization of local package version metadata in an existing `Cargo.lock`, without invoking Cargo or resolving dependencies. Stop if required synchronization cannot be represented safely.

## Go Tasks

- [ ] Detect module identity using `go.mod`; use `VERSION` for local project version tracking rather than treating dependency or Go toolchain versions as the module's own version.
- [ ] Derive module-compatible `v` tags and subdirectory prefixes, accounting for major-version directory layouts.
- [ ] Scope tag lookup and latest-version detection to the relevant module.
- [ ] Detect target major versions requiring module/import-path migration. Stop before edits, commits, tags, or releases and describe the required manual work.
- [ ] Prepare required module tags for integration in Phase G; respect `create_tag: false` and detect collisions.

## Acceptance Criteria

- [ ] Maven, both Gradle script variants, Rust package/workspace versions, and Go `VERSION` sources have fixture coverage.
- [ ] Native values normalize correctly for independent and unified release plans.
- [ ] No JVM, Cargo, Go, or build scripts are executed.
- [ ] Shared declarations are updated once or rejected when requested versions conflict.
- [ ] Go nested-module tags are correct, and migration-required targets fail before mutations.
- [ ] Formatting and unrelated dependency declarations remain intact.

## References

- [Maven CI-friendly versions](https://maven.apache.org/guides/mini/guide-maven-ci-friendly.html)
- [Gradle property configuration](https://docs.gradle.org/current/userguide/build_environment.html)
- [Cargo workspace inheritance](https://doc.rust-lang.org/cargo/reference/workspaces.html)
- [Go module versions and tags](https://go.dev/ref/mod#versions)
- [Go module source layouts](https://go.dev/doc/modules/managing-source)

## Implementation Record

- Changes: None.
- Validation: Not run; planning only.
- Blockers: None recorded.
