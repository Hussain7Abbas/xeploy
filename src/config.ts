import * as fs from "node:fs";
import * as path from "node:path";
import { discoverProjectDirectories, parseSubmodules } from "./discover.js";
import { getRawTags, listBranches } from "./git.js";
import type { ProjectConfig } from "./project-model.js";
import type { ProjectDescriptor } from "./project-model.js";
import { projectPath, validateProjectConfig } from "./project-model.js";
import { resolveProject } from "./projects.js";
import { detectTagPrefix } from "./semver.js";
import { assertBranchName, assertRepoRelativePath, isValidBranchName } from "./validate.js";

export type RepoType = "default" | "mono" | "meta";
export type EnvName = "develop" | "staging" | "uat" | "sandbox" | "production";
export type CreatePrEnv = "staging" | "uat" | "sandbox" | "production";
export type ReleaseEnv = "staging" | "uat" | "sandbox" | "production";

export const CONFIG_FILE = ".xeploy.json";

export const ENV_NAMES: EnvName[] = ["develop", "staging", "uat", "sandbox", "production"];
export const CREATE_PR_ENVS: CreatePrEnv[] = ["staging", "uat", "sandbox", "production"];
export const RELEASE_ENVS: ReleaseEnv[] = ["staging", "uat", "sandbox", "production"];

export const RC_ENVS: ReleaseEnv[] = ["staging", "uat"];
export const FINAL_ENVS: ReleaseEnv[] = ["sandbox", "production"];

const DEFAULT_ENV_BRANCH_NAMES: Record<EnvName, string> = {
  develop: "develop",
  staging: "staging",
  uat: "uat",
  sandbox: "sandbox",
  production: "main",
};

export interface SubprojectConfig {
  repo: string;
  enabled: boolean;
  path?: string;
  project?: ProjectConfig;
  // meta-only overrides (submodules are separate repos with their own PR/branch mapping)
  create_pr?: Record<CreatePrEnv, boolean>;
  create_tag?: boolean;
  environments?: Record<EnvName, string | null>;
}

export interface SubprojectSelection {
  includeUmbrella: boolean;
  repos: string[];
}

export interface XEployConfig {
  type: RepoType;
  project?: ProjectConfig;
  subprojectsDir: string | null;
  tag_prefix: string;
  generate_release_notes: boolean;
  create_production_release_branch: boolean;
  create_tag: boolean;
  create_pr: Record<CreatePrEnv, boolean>;
  environments: Record<EnvName, string | null>;
  subprojects?: SubprojectConfig[];
}

function defaultCreatePr(): Record<CreatePrEnv, boolean> {
  return {
    staging: false,
    uat: false,
    sandbox: false,
    production: false,
  };
}

export function mapEnvironmentsToBranches(branches: string[]): Record<EnvName, string | null> {
  const mapped = {} as Record<EnvName, string | null>;
  for (const env of ENV_NAMES) {
    const expected = DEFAULT_ENV_BRANCH_NAMES[env];
    mapped[env] = branches.includes(expected) ? expected : null;
  }
  return mapped;
}

export function detectRepoType(cwd: string): RepoType {
  if (fs.existsSync(path.join(cwd, ".gitmodules"))) {
    return "meta";
  }
  const children = discoverProjectDirectories(cwd).filter((dir) => dir !== ".");
  if (children.length > 0) {
    return "mono";
  }
  return "default";
}

export function detectSubprojectsDir(cwd: string): string | null {
  const children = discoverProjectDirectories(cwd).filter((directory) => directory !== ".");
  if (!children.length) return null;
  let common = path
    .dirname(children[0] ?? ".")
    .split(path.sep)
    .filter((part) => part !== ".");
  for (const child of children.slice(1)) {
    const parent = path.dirname(child).split(path.sep);
    let length = 0;
    while (length < common.length && common[length] === parent[length]) length++;
    common = common.slice(0, length);
  }
  return common.length ? common.join(path.sep) : null;
}

function discoverMonoSubprojectNames(cwd: string, subprojectsDir: string | null): string[] {
  const parent = path.resolve(cwd, subprojectsDir ?? ".");
  if (!fs.existsSync(parent)) return [];
  return discoverProjectDirectories(parent)
    .map((dir) => path.relative(cwd, path.join(parent, dir)))
    .filter((dir) => dir !== "." && path.resolve(cwd, dir).startsWith(`${parent}${path.sep}`))
    .map((dir) => path.relative(parent, path.resolve(cwd, dir)));
}

function defaultSubprojectEntry(
  repo: string,
  type: RepoType,
  branches: string[],
): SubprojectConfig {
  if (type === "meta") {
    return {
      repo,
      enabled: true,
      create_pr: defaultCreatePr(),
      create_tag: true,
      environments: mapEnvironmentsToBranches(branches),
    };
  }
  return { repo, enabled: true };
}

export function buildSubprojectsConfig(
  cwd: string,
  type: RepoType,
  subprojectsDir: string | null,
  branches: string[],
): SubprojectConfig[] {
  if (type === "meta") {
    return parseSubmodules(cwd).map((sub) => ({
      ...defaultSubprojectEntry(sub.name, type, branches),
      path: sub.path,
    }));
  }
  if (type === "mono") {
    return discoverMonoSubprojectNames(cwd, subprojectsDir).map((name) =>
      defaultSubprojectEntry(name, type, branches),
    );
  }
  return [];
}

export function getEnabledSubprojects(config: XEployConfig): SubprojectConfig[] {
  return (config.subprojects ?? []).filter((s) => s.enabled);
}

/** Local release targets only; meta children resolve within their own Git repositories. */
export function resolveProjects(
  config: XEployConfig,
  cwd: string,
  selection?: SubprojectSelection,
): ProjectDescriptor[] {
  const projects: ProjectDescriptor[] = [];
  if (!selection || selection.includeUmbrella)
    projects.push(resolveProject(cwd, ".", config.project));
  if (config.type === "mono") {
    for (const sub of getEnabledSubprojects(config)) {
      if (selection && !selection.repos.includes(sub.repo)) continue;
      projects.push(
        resolveProject(
          cwd,
          sub.path ?? path.join(config.subprojectsDir ?? ".", sub.repo),
          sub.project,
        ),
      );
    }
  }
  return projects;
}

/** Configured primary file paths, retained for programmatic compatibility. */
export function resolveVersionFiles(
  config: XEployConfig,
  cwd: string,
  selection?: SubprojectSelection,
): string[] {
  return resolveProjects(config, cwd, selection).map((project) =>
    path.join(project.directory, project.versionFile),
  );
}

function sanitizeEnvironments(
  environments: Record<EnvName, string | null>,
): Record<EnvName, string | null> {
  const sanitized = { ...environments };
  for (const env of ENV_NAMES) {
    const branch = sanitized[env];
    if (branch !== null && !isValidBranchName(branch)) {
      sanitized[env] = null;
    }
  }
  return sanitized;
}

function normalizeSubprojectEntry(
  entry: Partial<SubprojectConfig>,
  defaults: SubprojectConfig,
): SubprojectConfig {
  const normalized: SubprojectConfig = {
    repo: entry.repo ?? defaults.repo,
    enabled: entry.enabled ?? defaults.enabled,
    path: entry.path ?? defaults.path,
    project: entry.project ?? defaults.project,
  };
  if (defaults.create_pr) {
    normalized.create_pr = { ...defaults.create_pr, ...entry.create_pr };
  }
  if (defaults.create_tag !== undefined || entry.create_tag !== undefined) {
    normalized.create_tag = entry.create_tag ?? defaults.create_tag ?? true;
  }
  if (defaults.environments) {
    normalized.environments = sanitizeEnvironments({
      ...defaults.environments,
      ...entry.environments,
    });
  }
  return normalized;
}

export function createDefaultConfig(cwd: string): XEployConfig {
  const type = detectRepoType(cwd);
  const subprojectsDir = type === "default" ? null : detectSubprojectsDir(cwd);
  const branches = listBranches(cwd);

  const config: XEployConfig = {
    type,
    subprojectsDir,
    tag_prefix: detectTagPrefix(getRawTags(cwd)),
    generate_release_notes: true,
    create_production_release_branch: true,
    create_tag: true,
    create_pr: defaultCreatePr(),
    environments: mapEnvironmentsToBranches(branches),
  };

  if (type === "meta" || type === "mono") {
    config.subprojects = buildSubprojectsConfig(cwd, type, subprojectsDir, branches);
  }

  return config;
}

export function configPath(cwd: string): string {
  return path.join(cwd, CONFIG_FILE);
}

export function configExists(cwd: string): boolean {
  return fs.existsSync(configPath(cwd));
}

export function loadConfig(cwd: string = process.cwd()): XEployConfig | null {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<XEployConfig>;
    return normalizeConfig(raw, cwd);
  } catch {
    console.warn(`[xeploy] Failed to parse ${CONFIG_FILE} — using detected defaults.`);
    return createDefaultConfig(cwd);
  }
}

function normalizeSubprojectsConfig(
  rawSubprojects: Partial<SubprojectConfig>[] | undefined,
  subprojectDefaults: SubprojectConfig[],
): SubprojectConfig[] | undefined {
  if (subprojectDefaults.length === 0) {
    if (!rawSubprojects || rawSubprojects.length === 0) {
      return undefined;
    }
    return rawSubprojects.map((entry) =>
      normalizeSubprojectEntry(entry, {
        repo: entry.repo ?? "unknown",
        enabled: true,
      }),
    );
  }

  const normalized = (rawSubprojects ?? []).map((entry) => {
    const match = subprojectDefaults.find((s) => s.repo === entry.repo);
    const base = match ?? { repo: entry.repo ?? "unknown", enabled: true };
    return normalizeSubprojectEntry(entry, base);
  });

  const repos = new Set(normalized.map((s) => s.repo));
  for (const entry of subprojectDefaults) {
    if (!repos.has(entry.repo)) {
      normalized.push(entry);
    }
  }

  return normalized;
}

function configHasMissingDefaults(raw: Partial<XEployConfig>, defaults: XEployConfig): boolean {
  if (raw.type === undefined) {
    return true;
  }
  if (raw.subprojectsDir === undefined) {
    return true;
  }
  if (raw.tag_prefix === undefined) {
    return true;
  }
  if (raw.generate_release_notes === undefined) {
    return true;
  }
  if (raw.create_production_release_branch === undefined) {
    return true;
  }
  if (raw.create_tag === undefined) {
    return true;
  }
  if (raw.create_pr === undefined) {
    return true;
  }
  if (raw.environments === undefined) {
    return true;
  }

  for (const env of CREATE_PR_ENVS) {
    if (raw.create_pr?.[env] === undefined) {
      return true;
    }
  }
  for (const env of ENV_NAMES) {
    if (raw.environments?.[env] === undefined) {
      return true;
    }
  }

  if (defaults.subprojects && defaults.subprojects.length > 0) {
    if (raw.subprojects === undefined) {
      return true;
    }
    const rawRepos = new Set(raw.subprojects.map((s) => s.repo));
    for (const entry of defaults.subprojects) {
      if (!rawRepos.has(entry.repo)) {
        return true;
      }
    }
    for (const entry of raw.subprojects) {
      if (entry.enabled === undefined) {
        return true;
      }
      const defaultEntry = defaults.subprojects.find((s) => s.repo === entry.repo);
      if (defaultEntry?.create_pr) {
        for (const env of CREATE_PR_ENVS) {
          if (entry.create_pr?.[env] === undefined) {
            return true;
          }
        }
      }
      if (defaultEntry?.create_tag !== undefined && entry.create_tag === undefined) {
        return true;
      }
      if (defaultEntry?.environments) {
        for (const env of ENV_NAMES) {
          if (entry.environments?.[env] === undefined) {
            return true;
          }
        }
      }
    }
  }

  return false;
}

function normalizeConfig(raw: Partial<XEployConfig>, cwd: string): XEployConfig {
  const defaults = createDefaultConfig(cwd);
  const subprojectDefaults = defaults.subprojects ?? [];
  const subprojects = normalizeSubprojectsConfig(raw.subprojects, subprojectDefaults);

  return {
    ...defaults,
    ...raw,
    create_pr: { ...defaults.create_pr, ...raw.create_pr },
    environments: sanitizeEnvironments({
      ...defaults.environments,
      ...raw.environments,
    }),
    subprojects,
  };
}

export function applyMissingDefaults(cwd: string = process.cwd()): {
  config: XEployConfig;
  updated: boolean;
} {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) {
    return { config: createDefaultConfig(cwd), updated: false };
  }

  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<XEployConfig>;
  const defaults = createDefaultConfig(cwd);
  const config = normalizeConfig(raw, cwd);
  const updated = configHasMissingDefaults(raw, defaults);
  if (updated) {
    writeConfig(cwd, config);
  }
  return { config, updated };
}

export function validateConfig(config: XEployConfig, cwd: string): void {
  if (config.project) validateProjectConfig(config.project);
  if (!/^[\w.-]*$/.test(config.tag_prefix)) {
    throw new Error(`Invalid tag_prefix: ${config.tag_prefix}`);
  }
  if (config.subprojectsDir) {
    assertRepoRelativePath(cwd, config.subprojectsDir);
  }
  for (const env of ENV_NAMES) {
    const branch = config.environments[env];
    if (branch !== null) {
      assertBranchName(branch);
    }
  }
  if (config.subprojects) {
    for (const entry of config.subprojects) {
      if (entry.path) projectPath(cwd, entry.path);
      if (entry.project) validateProjectConfig(entry.project);
      if (!entry.environments) {
        continue;
      }
      for (const env of ENV_NAMES) {
        const branch = entry.environments[env];
        if (branch !== null && branch !== undefined) {
          assertBranchName(branch);
        }
      }
    }
  }
}

export function writeConfig(cwd: string, config: XEployConfig): void {
  validateConfig(config, cwd);
  fs.writeFileSync(configPath(cwd), `${JSON.stringify(config, null, 2)}\n`);
}

export function getSubprojectConfig(
  config: XEployConfig,
  repoName: string,
): SubprojectConfig | null {
  return config.subprojects?.find((s) => s.repo === repoName) ?? null;
}

export function isRcEnv(env: ReleaseEnv): boolean {
  return RC_ENVS.includes(env);
}

export function getConfiguredReleaseEnvs(config: XEployConfig): ReleaseEnv[] {
  return RELEASE_ENVS.filter((env) => config.environments[env] !== null);
}

export function formatConfigValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
