import * as path from "node:path";
import * as p from "@clack/prompts";
import type { SubprojectSelection, XEployConfig } from "./config.js";
import { CONFIG_FILE, writeConfig } from "./config.js";
import { getRawTags, listSubmodules } from "./git.js";
import { goModuleTag } from "./go-project.js";
import type { ProjectConfig, ProjectDescriptor } from "./project-model.js";
import { AmbiguousProjectError, ProjectSourceError } from "./project-model.js";
import { readProjectVersion, resolveProject } from "./projects.js";
import { BACK } from "./prompts-util.js";
import { compareSemVer, formatSemVer, parseSemVer } from "./semver.js";
import { assertReleaseVersion } from "./validate.js";

export function applicableProjectVersions(project: ProjectDescriptor, prefix = "") {
  return getRawTags(project.root)
    .flatMap((tag) => {
      if (project.ecosystem === "go") {
        const match = tag.match(/(?:^|\/)v(\d+\.\d+\.\d+(?:-rc\.\d+)?)$/)?.[1];
        if (!match) return [];
        try {
          if (goModuleTag(project, match) !== tag) return [];
        } catch {
          return [];
        }
        const version = parseSemVer(match);
        return version ? [version] : [];
      }
      if (project.id !== "." || (prefix && !tag.startsWith(prefix))) return [];
      const version = parseSemVer(prefix ? tag.slice(prefix.length) : tag);
      return version ? [version] : [];
    })
    .sort((a, b) => compareSemVer(b, a));
}

/** Persist source decisions only. VERSION and release-state files are created by release edits. */
export async function configureProjectSources(
  config: XEployConfig,
  root: string,
  selection?: SubprojectSelection,
  explicitVersion?: string,
): Promise<typeof BACK | undefined> {
  const scopes: {
    root: string;
    directory: string;
    settings?: ProjectConfig;
    save: (settings: ProjectConfig) => void;
  }[] = [];
  if (!selection || selection.includeUmbrella)
    scopes.push({
      root,
      directory: ".",
      settings: config.project,
      save: (settings) => {
        config.project = settings;
      },
    });
  const submodules = config.type === "meta" ? listSubmodules(root) : [];
  for (const sub of config.subprojects ?? []) {
    if (!sub.enabled || (selection && !selection.repos.includes(sub.repo))) continue;
    if (config.type !== "mono" && config.type !== "meta") continue;
    const directory = sub.path ?? path.join(config.subprojectsDir ?? ".", sub.repo);
    const module = submodules.find((module) => module.name === sub.repo);
    scopes.push({
      root: config.type === "meta" ? path.join(root, module?.path ?? directory) : root,
      directory: config.type === "meta" ? "." : directory,
      settings: sub.project,
      save: (settings) => {
        sub.project = settings;
      },
    });
  }
  let dirty = false;
  for (const scope of scopes) {
    let settings = scope.settings ?? {};
    let project: ProjectDescriptor;
    try {
      project = resolveProject(scope.root, scope.directory, settings);
    } catch (error) {
      if (!(error instanceof AmbiguousProjectError) || !process.stdin.isTTY) throw error;
      const chosen = await p.select({
        message: `Version source for ${scope.directory}`,
        options: error.candidates.map((candidate) => ({
          label: `${candidate.ecosystem}: ${candidate.file}`,
          value: candidate,
        })),
      });
      if (p.isCancel(chosen)) return BACK;
      settings = { ...settings, ecosystem: chosen.ecosystem, version_file: chosen.file };
      project = resolveProject(scope.root, scope.directory, settings);
      scope.save(settings);
      dirty = true;
    }
    if (readProjectVersion(project) !== null) continue;
    const latest = applicableProjectVersions(project, config.tag_prefix)[0];
    if (latest) settings = { ...settings, initial_version: formatSemVer(latest) };
    else if (explicitVersion)
      continue; // The requested release supplies the new file's value.
    else {
      if (!process.stdin.isTTY)
        throw new ProjectSourceError(
          `Missing version for ${scope.directory}; set project.initial_version in ${CONFIG_FILE} or supply --version`,
        );
      const initial = await p.text({
        message: `Starting version for ${scope.directory}`,
        initialValue: "0.1.0",
        validate: (value) => {
          try {
            assertReleaseVersion(value ?? "");
          } catch (error) {
            return String(error);
          }
        },
      });
      if (p.isCancel(initial)) return BACK;
      settings = { ...settings, initial_version: initial };
    }
    scope.save(settings);
    dirty = true;
  }
  if (dirty) writeConfig(root, config);
}
