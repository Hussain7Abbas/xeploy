import * as path from "node:path";
import type { SubprojectSelection, XEployConfig } from "./config.js";
import { resolveProjects } from "./config.js";
import { getRawTags, run, runInherit } from "./git.js";
import { goModuleTag } from "./go-project.js";
import type { FileEdit, ProjectDescriptor } from "./project-model.js";
import { AmbiguousProjectError, ProjectSourceError } from "./project-model.js";
import { mergeProjectEdits } from "./project-state.js";
import { prepareProjectVersion, projectVersionBindings, resolveProject } from "./projects.js";

export interface PreparedRepositoryVersions {
  projects: ProjectDescriptor[];
  edits: FileEdit[];
  moduleTags: string[];
}

export function prepareRepositoryVersions(
  config: XEployConfig,
  root: string,
  version: string,
  selection?: SubprojectSelection,
  overrides?: Record<string, string>,
  increments = 1,
  snapshot?: ReadonlyMap<string, string | null>,
): PreparedRepositoryVersions {
  const projects = resolveProjects(config, root, selection).map((project) => ({
    ...project,
    snapshot,
  }));
  const edits: FileEdit[] = [];
  const moduleTags: string[] = [];
  for (const project of projects) {
    if (project.gitDerived && !config.create_tag)
      throw new ProjectSourceError(
        "Python SCM versioning requires create_tag: true; configure a literal backend for bump-only releases",
      );
    const target = overrides?.[path.join(project.directory, project.versionFile)] ?? version;
    edits.push(...prepareProjectVersion(project, target, increments));
    if (project.ecosystem === "go" && config.create_tag) {
      const tag = goModuleTag(project, target);
      if (getRawTags(root).includes(tag))
        throw new ProjectSourceError(`Go module tag already exists: ${tag}`);
      moduleTags.push(tag);
    }
  }
  const merged = mergeProjectEdits(edits);
  const selectedIds = new Set(projects.map((project) => project.id));
  const sourcePaths = new Set(merged.map((edit) => edit.path));
  const allConfig = {
    ...config,
    subprojects: config.subprojects?.map((sub) => ({ ...sub, enabled: true })),
  };
  const selections = [
    { includeUmbrella: true, repos: [] as string[] },
    ...(allConfig.type === "mono"
      ? (allConfig.subprojects ?? []).map((sub) => ({ includeUmbrella: false, repos: [sub.repo] }))
      : []),
  ];
  for (const selection of selections) {
    let consumers: ProjectDescriptor[];
    try {
      consumers = resolveProjects(allConfig, root, selection);
    } catch (error) {
      if (!(error instanceof AmbiguousProjectError)) throw error;
      const sub = allConfig.subprojects?.find((sub) => sub.repo === selection.repos[0]);
      const directory =
        sub?.path ?? (sub ? path.join(allConfig.subprojectsDir ?? ".", sub.repo) : ".");
      consumers = error.candidates.map((candidate) =>
        resolveProject(root, directory, {
          ...sub?.project,
          ecosystem: candidate.ecosystem,
          version_file: candidate.file,
        }),
      );
    }
    for (const project of consumers) {
      if (selectedIds.has(project.id)) continue;
      let bindings: ReturnType<typeof projectVersionBindings>;
      try {
        bindings = projectVersionBindings({ ...project, snapshot });
      } catch {
        // An unresolved sibling is irrelevant unless a changed declaration could own it.
        const inheritedNames =
          project.ecosystem === "dotnet"
            ? ["Directory.Build.props"]
            : project.ecosystem === "rust"
              ? ["Cargo.toml"]
              : project.ecosystem === "java"
                ? ["pom.xml"]
                : [];
        const explicitFiles = (project.platformFields ?? []).map((field) =>
          path.join(project.directory, field.file),
        );
        const shared = [...sourcePaths].some(
          (file) =>
            explicitFiles.includes(file) ||
            (inheritedNames.includes(path.basename(file)) &&
              path.dirname(file) !== project.directory &&
              !path.relative(path.dirname(file), project.directory).startsWith("..")),
        );
        if (shared)
          throw new ProjectSourceError(
            `Cannot establish shared-source ownership for unselected project ${project.id}; configure its source explicitly`,
          );
        continue;
      }
      if (
        bindings.some((binding) =>
          merged.some(
            (edit) =>
              edit.path === binding.file &&
              (!binding.span ||
                !edit.changes ||
                edit.changes.some(
                  (change) =>
                    change.start < (binding.span?.end ?? 0) &&
                    change.end > (binding.span?.start ?? 0),
                )),
          ),
        )
      )
        throw new ProjectSourceError(
          `Shared version source would change unselected project ${project.id}; select all consumers or configure independent sources`,
        );
    }
  }
  return { projects, edits: merged, moduleTags: [...new Set(moduleTags)] };
}

/** Tags point at the committed version batch; never move an existing tag. */
export function createModuleTags(root: string, tags: string[]): void {
  for (const tag of tags) {
    if (!/^(?:[A-Za-z0-9._-]+\/)*v\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(tag) || tag.includes("..")) {
      throw new ProjectSourceError(`Invalid Go module tag: ${tag}`);
    }
    const existing = getRawTags(root).includes(tag);
    if (
      existing &&
      run("git", ["rev-list", "-n", "1", `refs/tags/${tag}`], root) !==
        run("git", ["rev-parse", "HEAD"], root)
    ) {
      throw new ProjectSourceError(`Go module tag already points to a different commit: ${tag}`);
    }
    if (!existing) runInherit("git", ["tag", "--", tag, "HEAD"], root);
    runInherit("git", ["push", "origin", `refs/tags/${tag}`], root);
  }
}
