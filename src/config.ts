import * as fs from "node:fs";
import * as path from "node:path";
import { parseSubmodules } from "./discover.js";
import { listBranches } from "./git.js";
import { assertBranchName, assertRepoRelativePath, isValidBranchName } from "./validate.js";

export type RepoType = "default" | "mono" | "meta";
export type EnvName = "develop" | "staging" | "uat" | "sandbox" | "production";
export type CreatePrEnv = "staging" | "uat" | "sandbox" | "production";
export type ReleaseEnv = "staging" | "uat" | "sandbox" | "production";

export const CONFIG_FILE = ".xbump.json";

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

export interface MetaRepoConfig {
  repo: string;
  create_pr: Record<CreatePrEnv, boolean>;
  environments: Record<EnvName, string | null>;
}

export interface XBumpConfig {
  type: RepoType;
  subprojectsDir: string | null;
  versionFiles: string[];
  generate_release_notes: boolean;
  create_production_release_branch: boolean;
  create_pr: Record<CreatePrEnv, boolean>;
  environments: Record<EnvName, string | null>;
  meta?: MetaRepoConfig[];
}

function defaultCreatePr(): Record<CreatePrEnv, boolean> {
  return {
    staging: true,
    uat: true,
    sandbox: true,
    production: true,
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
  const pkgCount = countPackageJsonFiles(cwd);
  if (pkgCount > 1) {
    return "mono";
  }
  return "default";
}

function countPackageJsonFiles(cwd: string): number {
  let count = 0;
  walkDir(cwd, (file) => {
    if (path.basename(file) === "package.json" && !file.includes("node_modules")) {
      count++;
    }
  });
  return count;
}

function walkDir(dir: string, onFile: (file: string) => void): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, onFile);
    } else if (entry.isFile()) {
      onFile(full);
    }
  }
}

export function detectSubprojectsDir(cwd: string): string | null {
  const appsDir = path.join(cwd, "apps");
  if (fs.existsSync(appsDir) && fs.statSync(appsDir).isDirectory()) {
    return "apps";
  }

  const dirCounts = new Map<string, number>();
  walkDir(cwd, (file) => {
    if (path.basename(file) !== "package.json") {
      return;
    }
    const rel = path.relative(cwd, path.dirname(file));
    if (!rel || rel.startsWith("..")) {
      return;
    }
    const top = rel.split(path.sep)[0] ?? ".";
    if (top === ".") {
      return;
    }
    dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
  });

  let best: string | null = null;
  let bestCount = 0;
  for (const [dir, count] of dirCounts) {
    if (count > bestCount) {
      best = dir;
      bestCount = count;
    }
  }
  return best;
}

function discoverVersionFiles(
  cwd: string,
  type: RepoType,
  subprojectsDir: string | null,
): string[] {
  if (type === "default") {
    return ["package.json"];
  }

  const files: string[] = ["package.json"];
  if (!subprojectsDir) {
    return files;
  }

  const parent = path.join(cwd, subprojectsDir);
  if (!fs.existsSync(parent)) {
    return files;
  }

  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pkg = path.join(subprojectsDir, entry.name, "package.json");
    if (fs.existsSync(path.join(cwd, pkg))) {
      files.push(pkg);
    }
  }
  return files;
}

function buildMetaConfig(cwd: string, branches: string[]): MetaRepoConfig[] {
  return parseSubmodules(cwd).map((sub) => ({
    repo: sub.name,
    create_pr: defaultCreatePr(),
    environments: mapEnvironmentsToBranches(branches),
  }));
}

export function resolveVersionFiles(
  config: XBumpConfig,
  repoRoot: string,
  submoduleRelPath?: string,
): string[] {
  if (!submoduleRelPath) {
    return config.versionFiles.map((f) => {
      assertRepoRelativePath(repoRoot, f);
      return f;
    });
  }

  const normalizedSub = submoduleRelPath.replace(/\\/g, "/");
  const prefix = `${normalizedSub}/`;
  const matched = config.versionFiles
    .map((f) => f.replace(/\\/g, "/"))
    .filter((f) => f === normalizedSub || f.startsWith(prefix))
    .map((f) => (f === normalizedSub ? "package.json" : f.slice(prefix.length)));

  if (matched.length > 0) {
    return matched.map((f) => {
      assertRepoRelativePath(repoRoot, path.join(submoduleRelPath, f));
      return f;
    });
  }

  return ["package.json"];
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

function normalizeMetaEntry(
  entry: Partial<MetaRepoConfig>,
  defaults: MetaRepoConfig,
): MetaRepoConfig {
  return {
    repo: entry.repo ?? defaults.repo,
    create_pr: { ...defaults.create_pr, ...entry.create_pr },
    environments: sanitizeEnvironments({
      ...defaults.environments,
      ...entry.environments,
    }),
  };
}

export function createDefaultConfig(cwd: string): XBumpConfig {
  const type = detectRepoType(cwd);
  const subprojectsDir = type === "default" ? null : detectSubprojectsDir(cwd);
  const branches = listBranches(cwd);

  const config: XBumpConfig = {
    type,
    subprojectsDir,
    versionFiles: discoverVersionFiles(cwd, type, subprojectsDir),
    generate_release_notes: true,
    create_production_release_branch: true,
    create_pr: defaultCreatePr(),
    environments: mapEnvironmentsToBranches(branches),
  };

  if (type === "meta") {
    config.meta = buildMetaConfig(cwd, branches);
  }

  return config;
}

export function configPath(cwd: string): string {
  return path.join(cwd, CONFIG_FILE);
}

export function configExists(cwd: string): boolean {
  return fs.existsSync(configPath(cwd));
}

export function loadConfig(cwd: string = process.cwd()): XBumpConfig | null {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<XBumpConfig>;
    return normalizeConfig(raw, cwd);
  } catch {
    console.warn(`[xbump] Failed to parse ${CONFIG_FILE} — using detected defaults.`);
    return createDefaultConfig(cwd);
  }
}

function normalizeConfig(raw: Partial<XBumpConfig>, cwd: string): XBumpConfig {
  const defaults = createDefaultConfig(cwd);
  const metaDefaults = defaults.meta ?? [];

  const meta =
    raw.meta?.map((entry) => {
      const match = metaDefaults.find((m) => m.repo === entry.repo);
      const base = match ?? {
        repo: entry.repo ?? "unknown",
        create_pr: defaultCreatePr(),
        environments: mapEnvironmentsToBranches([]),
      };
      return normalizeMetaEntry(entry, base);
    }) ?? defaults.meta;

  return {
    ...defaults,
    ...raw,
    create_pr: { ...defaults.create_pr, ...raw.create_pr },
    environments: sanitizeEnvironments({
      ...defaults.environments,
      ...raw.environments,
    }),
    meta,
  };
}

export function validateConfig(config: XBumpConfig, cwd: string): void {
  for (const f of config.versionFiles) {
    assertRepoRelativePath(cwd, f);
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
  if (config.meta) {
    for (const entry of config.meta) {
      for (const env of ENV_NAMES) {
        const branch = entry.environments[env];
        if (branch !== null) {
          assertBranchName(branch);
        }
      }
    }
  }
}

export function writeConfig(cwd: string, config: XBumpConfig): void {
  validateConfig(config, cwd);
  fs.writeFileSync(configPath(cwd), `${JSON.stringify(config, null, 2)}\n`);
}

export function getMetaRepoConfig(config: XBumpConfig, repoName: string): MetaRepoConfig | null {
  return config.meta?.find((m) => m.repo === repoName) ?? null;
}

export function isRcEnv(env: ReleaseEnv): boolean {
  return RC_ENVS.includes(env);
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
