import * as fs from "node:fs";
import * as path from "node:path";
import { assertReleaseVersion, assertRepoRelativePath } from "./validate.js";

export const ECOSYSTEMS = [
  "javascript",
  "dotnet",
  "python",
  "java",
  "rust",
  "go",
  "flutter",
  "unity",
  "godot",
  "unreal",
  "generic",
] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

/** File paths are relative to the project, which itself belongs to one Git repository. */
export interface ProjectConfig {
  ecosystem?: Ecosystem;
  version_file?: string;
  initial_version?: string;
  platform_fields?: PlatformFieldConfig[];
}

export interface PlatformFieldConfig {
  file: string;
  format: "json" | "ini" | "yaml" | "xml" | "plist";
  key: string;
  section?: string;
  kind: "release" | "base" | "counter" | "apple-counter" | "numeric4" | "assembly" | "suffix";
  limit?: number;
}

export interface ProjectCandidate {
  ecosystem: Ecosystem;
  file: string;
}

export interface ProjectDescriptor {
  id: string;
  root: string;
  directory: string;
  ecosystem: Ecosystem;
  versionFile: string;
  initialVersion?: string;
  platformFields?: PlatformFieldConfig[];
  gitDerived?: boolean;
  /** Planning overlay for later tiers; never serialized into configuration. */
  snapshot?: ReadonlyMap<string, string | null>;
}

export interface FileEdit {
  /** Path relative to the Git repository root. */
  path: string;
  before: string | null;
  after: string;
  changes?: { start: number; end: number; value: string; replacement: string }[];
}

export interface VersionAdapter {
  read(project: ProjectDescriptor): string | null;
  prepare(project: ProjectDescriptor, version: string): FileEdit[];
}

export class ProjectSourceError extends Error {}

export class AmbiguousProjectError extends ProjectSourceError {
  constructor(
    public readonly candidates: ProjectCandidate[],
    directory: string,
  ) {
    super(
      `Multiple version sources in ${directory}; set project.ecosystem and project.version_file in .xeploy.json`,
    );
  }
}

/** Check lexical and physical boundaries, including symlinked parents of new files. */
export function projectPath(root: string, relative: string): string {
  const absolute = assertRepoRelativePath(root, relative);
  if (path.relative(path.resolve(root), absolute).split(path.sep).includes(".git"))
    throw new ProjectSourceError(`Version bindings cannot write Git metadata: ${relative}`);
  let component = path.resolve(root);
  for (const part of path.relative(component, absolute).split(path.sep).filter(Boolean)) {
    component = path.join(component, part);
    try {
      if (fs.lstatSync(component).isSymbolicLink())
        throw new ProjectSourceError(`Version paths cannot traverse a symlink: ${relative}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  let ancestor = absolute;
  while (!fs.existsSync(ancestor)) {
    try {
      if (fs.lstatSync(ancestor).isSymbolicLink())
        throw new ProjectSourceError(`Broken symbolic link in version path: ${relative}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new ProjectSourceError(`Missing project root: ${root}`);
    ancestor = parent;
  }
  assertRepoRelativePath(
    fs.realpathSync(root),
    path.relative(fs.realpathSync(root), fs.realpathSync(ancestor)),
  );
  return absolute;
}

export function validateProjectConfig(config: ProjectConfig): void {
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new ProjectSourceError("Project settings must be an object");
  if (config.ecosystem && !ECOSYSTEMS.includes(config.ecosystem)) {
    throw new ProjectSourceError(`Unknown project ecosystem: ${config.ecosystem}`);
  }
  if (config.initial_version) assertReleaseVersion(config.initial_version);
  if (
    config.version_file !== undefined &&
    (typeof config.version_file !== "string" || !config.version_file)
  )
    throw new ProjectSourceError("project.version_file must be a nonempty path");
  if (config.platform_fields !== undefined && !Array.isArray(config.platform_fields))
    throw new ProjectSourceError("project.platform_fields must be an array");
  for (const field of config.platform_fields ?? []) {
    if (
      !field ||
      typeof field.file !== "string" ||
      !field.file ||
      typeof field.key !== "string" ||
      !field.key ||
      !["json", "ini", "yaml", "xml", "plist"].includes(field.format) ||
      !["release", "base", "counter", "apple-counter", "numeric4", "assembly", "suffix"].includes(
        field.kind,
      ) ||
      (field.limit !== undefined && (!Number.isSafeInteger(field.limit) || field.limit < 1))
    ) {
      throw new ProjectSourceError("Invalid project.platform_fields entry");
    }
  }
}

/** Only the currently supported final/RC release family can be normalized losslessly. */
export function canonicalVersion(value: string, ecosystem?: Ecosystem): string {
  let canonical = value.trim();
  if (ecosystem === "java")
    canonical = canonical.replace(/-SNAPSHOT$/i, "-rc.0").replace(/-rc[.-]?(\d+)$/i, "-rc.$1");
  if (ecosystem === "python") canonical = canonical.replace(/(?<=\d)rc(\d+)$/, "-rc.$1");
  if (ecosystem && ["unity", "godot", "unreal", "dotnet", "python", "java"].includes(ecosystem))
    canonical = canonical.replace(/^(\d+\.\d+)(-rc\.\d+)?$/, "$1.0$2");
  if (ecosystem === "unreal" && /^\d+\.\d+\.\d+\.\d+$/.test(canonical))
    canonical = canonical.split(".").slice(0, 3).join(".");
  if (ecosystem === "flutter") canonical = canonical.replace(/\+\d+$/, "");
  return assertReleaseVersion(canonical);
}
