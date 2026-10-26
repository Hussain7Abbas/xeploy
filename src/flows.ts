import * as path from "node:path";
import * as p from "@clack/prompts";
import type { ReleaseOptions } from "./cli-options.js";
import type {
  CreatePrEnv,
  ReleaseEnv,
  SubprojectConfig,
  SubprojectSelection,
  XEployConfig,
} from "./config.js";
import {
  CONFIG_FILE,
  FINAL_ENVS,
  RC_ENVS,
  getConfiguredReleaseEnvs,
  getEnabledSubprojects,
  getSubprojectConfig,
  isRcEnv,
  resolveProjects,
  resolveVersionFiles,
} from "./config.js";
import {
  checkRepoWriteAccess,
  createRelease,
  createReleaseBranch,
  currentBranch,
  fetchTags,
  getLatestFinalTag,
  getLatestRcTag,
  getLatestTag,
  getRawTags,
  getRcTags,
  getTags,
  ghReleaseExists,
  initSubmodules,
  listSubmodules,
  mergeOrPr,
  pushBranch,
  remoteBranchExists,
  requireCleanTree,
  resolveTagsWithSpinner,
  run,
  runInherit,
  syncBranch,
  tagExists,
  tryRun,
} from "./git.js";
import type { BackgroundTagFetch } from "./git.js";
import { goModuleTag } from "./go-project.js";
import { prepareHistoricalRelease } from "./historical-release.js";
import type { ProjectDescriptor } from "./project-model.js";
import { createModuleTags, prepareRepositoryVersions } from "./project-release.js";
import type { PreparedRepositoryVersions } from "./project-release.js";
import { applicableProjectVersions, configureProjectSources } from "./project-setup.js";
import { readProjectVersion, resolveProject } from "./projects.js";
import { BACK, abort, cancelAsBack, isBack } from "./prompts-util.js";
import {
  beginReleaseJournal,
  completeReleaseJournal,
  releaseStep,
  verifyReleaseResume,
} from "./release-journal.js";
import {
  bumpVersion,
  compareSemVer,
  formatGitTag,
  formatReleaseBranch,
  formatSemVer,
  parseSemVer,
  toGitTag,
} from "./semver.js";
import type { BumpType, SemVer } from "./semver.js";
import { assertReleaseVersion, resolveSubmodulePath } from "./validate.js";
import { bumpVersionFiles } from "./versions.js";

function configuredTags(cwd: string, prefix: string): SemVer[] {
  return getRawTags(cwd).flatMap((tag) => {
    if (prefix && !tag.startsWith(prefix)) return [];
    const version = parseSemVer(prefix ? tag.slice(prefix.length) : tag);
    return version ? [version] : [];
  });
}

function releaseNote(tag: string, notesStart: string | null, prerelease: boolean): string {
  return [
    `Tag:         ${tag}  (${prerelease ? "pre-release" : "final"})`,
    `Notes since: ${notesStart ?? "beginning of history"}`,
  ].join("\n");
}

function stripRc(version: SemVer): SemVer {
  return { ...version, rc: null };
}

function resolveBumpBase(tags: SemVer[], needsRc: boolean, needsFinal: boolean): SemVer | null {
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const latestRc = getLatestRcTag(tags);

  if (needsFinal && !needsRc) {
    if (latestFinal) {
      return latestFinal;
    }
    if (latestRc) {
      return stripRc(latestRc);
    }
    return null;
  }

  return latest;
}

function formatBumpPreview(bumped: SemVer, needsRc: boolean, needsFinal: boolean): string {
  if (needsFinal && !needsRc) {
    return formatSemVer(stripRc(bumped));
  }
  return formatSemVer(bumped);
}

/**
 * Non-interactive equivalent of `promptBumpType` for a known bump type. Used to
 * recompute per-repo target versions from each repo's own tags/versions.
 */
function computeTierTags(
  tags: SemVer[],
  bumpType: BumpType,
  needsRc: boolean,
  needsFinal: boolean,
): RepoTierTags {
  const baseForBump = resolveBumpBase(tags, needsRc, needsFinal);
  const bumped = bumpVersion(bumpType, baseForBump);
  return {
    rcTag: needsRc ? formatSemVer(bumped) : null,
    finalTag: needsFinal ? formatSemVer(stripRc(bumped)) : null,
  };
}

function customTierTags(version: string, needsRc: boolean, needsFinal: boolean): RepoTierTags {
  assertReleaseVersion(version);
  const parsed = parseSemVer(version) as SemVer;
  return {
    rcTag: needsRc ? formatSemVer({ ...parsed, rc: parsed.rc ?? 1 }) : null,
    finalTag: needsFinal ? formatSemVer(stripRc(parsed)) : null,
  };
}

function validateTierTags(
  targets: RepoTierTags,
  tags: SemVer[],
  cwd: string,
  tagPrefix: string,
): void {
  for (const target of [targets.rcTag, targets.finalTag]) {
    if (!target) continue;
    assertReleaseVersion(target);
    if (tagExists(target, cwd, tagPrefix)) {
      throw new Error(`Tag "${toGitTag(target, tagPrefix)}" already exists`);
    }
    const parsed = parseSemVer(target) as SemVer;
    // Final releases may promote a newer RC of the same base version.
    const latest = getLatestTag(tags);
    if (latest && compareSemVer(parsed, latest) <= 0) {
      throw new Error(
        `Version ${target} must be greater than current latest "${formatSemVer(latest)}"`,
      );
    }
  }
}

function displayTierTag(tags: RepoTierTags): string {
  return tags.finalTag ?? tags.rcTag ?? "(none)";
}

function baseVersionString(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function getCreatePr(
  config: XEployConfig,
  env: CreatePrEnv,
  metaOverride?: SubprojectConfig,
): boolean {
  if (metaOverride?.create_pr) {
    return metaOverride.create_pr[env];
  }
  return config.create_pr[env];
}

function getCreateTag(config: XEployConfig, metaOverride?: SubprojectConfig): boolean {
  if (metaOverride?.create_tag !== undefined) {
    return metaOverride.create_tag;
  }
  return config.create_tag;
}

function getMetaEnvBranch(
  config: XEployConfig,
  env: ReleaseEnv,
  metaOverride?: SubprojectConfig,
): string | null {
  if (metaOverride?.environments) {
    return metaOverride.environments[env];
  }
  return config.environments[env];
}

const UMBRELLA_SELECTION = "__umbrella__";

export async function promptSubprojectSelection(
  config: XEployConfig,
): Promise<SubprojectSelection | typeof BACK> {
  if (config.type !== "mono" && config.type !== "meta") {
    return { includeUmbrella: true, repos: [] };
  }

  const enabled = getEnabledSubprojects(config);
  if (enabled.length === 0) {
    return { includeUmbrella: true, repos: [] };
  }

  const options = [
    { label: "Umbrella (this repo)", value: UMBRELLA_SELECTION },
    ...enabled.map((s) => ({ label: s.repo, value: s.repo })),
  ];

  const selected = cancelAsBack(
    await p.multiselect<string>({
      message: "Select repos to bump",
      options,
      initialValues: options.map((o) => o.value),
      required: false,
    }),
  );
  if (isBack(selected)) {
    return BACK;
  }

  return {
    includeUmbrella: selected.includes(UMBRELLA_SELECTION),
    repos: selected.filter((v) => v !== UMBRELLA_SELECTION),
  };
}

export function verifySelectedRepoAccess(
  config: XEployConfig,
  cwd: string,
  selection: SubprojectSelection,
): boolean {
  const s = p.spinner();
  s.start("Checking repository access");

  const checks = [];

  if (config.type === "meta") {
    requireCleanTree(cwd, { allowOnly: [CONFIG_FILE] });
    initSubmodules(cwd);
    const submoduleByName = new Map(listSubmodules(cwd).map((sub) => [sub.name, sub]));

    if (selection.includeUmbrella) {
      checks.push(checkRepoWriteAccess(cwd, "Umbrella (this repo)"));
    }

    for (const repoName of selection.repos) {
      const sub = submoduleByName.get(repoName);
      if (!sub) {
        checks.push({
          label: repoName,
          slug: "(unknown)",
          ok: false,
          error: "Submodule not found in .gitmodules",
        });
        continue;
      }
      checks.push(checkRepoWriteAccess(resolveSubmodulePath(cwd, sub.path), repoName));
    }
  } else if (config.type === "mono") {
    if (selection.includeUmbrella || selection.repos.length > 0) {
      checks.push(checkRepoWriteAccess(cwd, "This repo"));
    }
  } else {
    checks.push(checkRepoWriteAccess(cwd, "This repo"));
  }

  if (checks.length === 0) {
    s.stop("No repositories selected");
    return true;
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length === 0) {
    s.stop("Repository access verified");
    return true;
  }

  s.stop("Repository access check failed");
  for (const check of failed) {
    p.log.error(`${check.label} (${check.slug}): ${check.error ?? "No write access"}`);
  }
  if (config.type === "meta" || config.type === "mono") {
    p.log.error("Deselect inaccessible repos or request access before deploying.");
  } else {
    p.log.error("Request write access before deploying.");
  }
  return false;
}

async function promptBumpType(
  tags: SemVer[],
  needsRc: boolean,
  needsFinal: boolean,
  cwd: string,
  tagPrefix: string,
): Promise<
  { rcTag: string | null; finalTag: string | null; bumpType: BumpType | "custom" } | typeof BACK
> {
  const latest = getLatestTag(tags);
  const baseForBump = resolveBumpBase(tags, needsRc, needsFinal);
  const latestStr = latest ? formatSemVer(latest) : "(none)";
  const baseStr = baseForBump ? formatSemVer(baseForBump) : "(none)";

  while (true) {
    const rcOptions = needsRc
      ? [
          {
            label: `Release Candidate  →  ${formatSemVer(bumpVersion("rc", latest))}`,
            value: "rc" as BumpType,
          },
        ]
      : [];

    const bumpOptions = [
      ...rcOptions,
      {
        label: `Bug Fix            →  ${formatBumpPreview(bumpVersion("bugfix", baseForBump), needsRc, needsFinal)}`,
        value: "bugfix" as BumpType,
      },
      {
        label: `Minor              →  ${formatBumpPreview(bumpVersion("minor", baseForBump), needsRc, needsFinal)}`,
        value: "minor" as BumpType,
      },
      {
        label: `Major              →  ${formatBumpPreview(bumpVersion("major", baseForBump), needsRc, needsFinal)}`,
        value: "major" as BumpType,
      },
      { label: "Custom", value: "custom" as const },
    ];

    const bumpChoice = cancelAsBack(
      await p.select<BumpType | "custom">({
        message: `Select bump type  (current latest: ${needsFinal && !needsRc ? baseStr : latestStr})`,
        options: bumpOptions,
      }),
    );
    if (isBack(bumpChoice)) {
      return BACK;
    }

    if (bumpChoice === "custom") {
      while (true) {
        const customTag = cancelAsBack(
          await p.text({
            message:
              needsRc && !needsFinal
                ? "Enter custom version (e.g. 1.2.3-rc.1):"
                : "Enter custom version (e.g. 1.2.3 or 1.2.3-rc.1):",
            validate: (v) => {
              if (!v) {
                return "Version is required";
              }
              try {
                validateTierTags(customTierTags(v, needsRc, needsFinal), tags, cwd, tagPrefix);
              } catch (error) {
                return error instanceof Error ? error.message : String(error);
              }
            },
          }),
        );
        if (isBack(customTag)) {
          break;
        }
        return {
          ...customTierTags(customTag, needsRc, needsFinal),
          bumpType: "custom",
        };
      }
      continue;
    }

    const tierTags = computeTierTags(tags, bumpChoice as BumpType, needsRc, needsFinal);
    return { ...tierTags, bumpType: bumpChoice as BumpType };
  }
}

export interface RepoTierTags {
  rcTag: string | null;
  finalTag: string | null;
}

export interface ReleasePlan {
  journalRoot?: string;
  branchCheckouts?: Record<string, { branch: string; ref: string }>;
  republishSources?: Record<string, { ref: string; version: string }>;
  promotionSources?: Record<
    string,
    { ref: string; branch: string; originalBranch: string; version: string }
  >;
  preparedVersions?: Record<string, Partial<Record<"rc" | "final", PreparedRepositoryVersions>>>;
  selectedEnvs: ReleaseEnv[];
  rcTag: string | null;
  finalTag: string | null;
  /** Bump type chosen for this release (used to recompute per-repo targets). */
  bumpType?: BumpType | "custom";
  /**
   * Per-repo target versions keyed by repo/subproject name, used when the
   * user opts to bump inconsistent repos separately. The umbrella keeps the
   * top-level `rcTag`/`finalTag`.
   */
  perRepoTags?: Record<string, RepoTierTags>;
  /** Merge into paired env (decided upfront after version selection). */
  mergePairedEnv?: boolean;
}

const RELEASE_ENV_LABELS: Record<ReleaseEnv, string> = {
  staging: "staging release   (RC)",
  uat: "uat release       (RC)",
  sandbox: "sandbox release   (final)",
  production: "production release (final)",
};

const PAIRED_RELEASE_ENVS: Partial<Record<ReleaseEnv, ReleaseEnv>> = {
  staging: "uat",
  uat: "staging",
  sandbox: "production",
  production: "sandbox",
};

function getPairedReleaseEnv(env: ReleaseEnv): ReleaseEnv | null {
  return PAIRED_RELEASE_ENVS[env] ?? null;
}

function isPairedEnvEnabled(
  config: XEployConfig,
  pairedEnv: ReleaseEnv,
  metaOverride?: SubprojectConfig,
): boolean {
  return getMetaEnvBranch(config, pairedEnv, metaOverride) !== null;
}

function isPairedEnvEnabledForRelease(
  config: XEployConfig,
  pairedEnv: ReleaseEnv,
  selection?: SubprojectSelection,
): boolean {
  if (config.type === "default" || !selection) {
    return isPairedEnvEnabled(config, pairedEnv);
  }

  if (selection.includeUmbrella && isPairedEnvEnabled(config, pairedEnv)) {
    return true;
  }

  for (const repo of selection.repos) {
    const sub = getSubprojectConfig(config, repo);
    if (isPairedEnvEnabled(config, pairedEnv, sub ?? undefined)) {
      return true;
    }
  }

  return false;
}

async function ensureRemoteEnvBranch(opts: {
  branchName: string;
  fromBranch: string;
  env: ReleaseEnv;
  cwd: string;
}): Promise<boolean> {
  if (remoteBranchExists(opts.branchName, opts.cwd)) {
    return true;
  }

  const create = await p.confirm({
    message: `Branch "${opts.branchName}" (${opts.env}) does not exist on origin. Create it from "${opts.fromBranch}"?`,
    initialValue: true,
  });
  if (p.isCancel(create)) {
    abort();
  }
  if (!create) {
    return false;
  }

  const s = p.spinner();
  s.start(`Creating branch ${opts.branchName}`);
  try {
    createReleaseBranch(opts.branchName, opts.fromBranch, opts.cwd);
    s.stop(`Branch ${opts.branchName} created`);
    return true;
  } catch (error) {
    s.stop("Failed to create branch");
    throw new Error(`Could not publish environment branch ${opts.branchName}`, { cause: error });
  }
}

async function promptMergePairedEnv(
  pairedEnv: ReleaseEnv,
  config: XEployConfig,
  metaOverride?: SubprojectConfig,
): Promise<boolean> {
  const createPr = getCreatePr(config, pairedEnv, metaOverride);
  const message = createPr ? `Open PR into ${pairedEnv}?` : `Also merge into ${pairedEnv}?`;

  const merge = await p.confirm({
    message,
    initialValue: false,
  });
  if (p.isCancel(merge)) {
    abort();
  }
  return merge;
}

async function promptMergePairedEnvUpfront(
  plan: ReleasePlan,
  config: XEployConfig,
  cwd: string,
  selection?: SubprojectSelection,
): Promise<ReleasePlan | typeof BACK> {
  if (plan.mergePairedEnv !== undefined) {
    return plan;
  }
  const primaryEnv = plan.selectedEnvs[0];
  if (!primaryEnv) {
    return plan;
  }

  const pairedEnv = getPairedReleaseEnv(primaryEnv);
  if (!pairedEnv) {
    return plan;
  }

  if (!isPairedEnvEnabledForRelease(config, pairedEnv, selection)) {
    return plan;
  }

  const createPr = getCreatePr(config, pairedEnv);
  const repoScope =
    config.type === "meta" || config.type === "mono" ? " for all selected repos" : "";
  const message = createPr
    ? `Open PR into ${pairedEnv}${repoScope}?`
    : `Also merge into ${pairedEnv}${repoScope}?`;

  const merge = cancelAsBack(
    await p.confirm({
      message,
      initialValue: false,
    }),
  );
  if (isBack(merge)) {
    return BACK;
  }

  return { ...plan, mergePairedEnv: merge };
}

export async function planRelease(
  config: XEployConfig,
  tagFetch: BackgroundTagFetch,
  cwd: string,
  options: ReleaseOptions = {},
  selection?: SubprojectSelection,
): Promise<ReleasePlan | typeof BACK> {
  const availableEnvs = getConfiguredReleaseEnvs(config);
  if (availableEnvs.length === 0) {
    p.cancel("No release environments configured in .xeploy.json.");
    process.exit(1);
  }
  if (options.environments) {
    if (options.environments.length === 0) {
      throw new Error("Select at least one release environment");
    }
    for (const env of options.environments) {
      if (!availableEnvs.includes(env)) {
        throw new Error(`Environment "${env}" is not configured in .xeploy.json`);
      }
    }
  }

  while (true) {
    const selected =
      options.environments ??
      cancelAsBack(
        await p.select<ReleaseEnv>({
          message: "Select release environment",
          options: availableEnvs.map((env) => ({
            label: RELEASE_ENV_LABELS[env],
            value: env,
          })),
        }),
      );
    if (isBack(selected)) {
      return BACK;
    }

    const selectedEnvs = Array.isArray(selected) ? selected : [selected];
    const needsRc = selectedEnvs.some((env) => RC_ENVS.includes(env));
    const needsFinal = selectedEnvs.some((env) => FINAL_ENVS.includes(env));
    if (options.bump === "rc" && !needsRc) {
      throw new Error("--bump rc requires staging or uat to be selected");
    }

    while (true) {
      const fetchedTags = await resolveTagsWithSpinner(tagFetch, cwd);
      let tags = config.tag_prefix ? configuredTags(cwd, config.tag_prefix) : fetchedTags;
      if (config.type === "mono" && selection) {
        tags = gatherMonoRepoVersions(config, cwd, selection).flatMap((info) => info.tags);
      } else if (config.type === "meta" && selection) {
        tags = gatherMetaRepoVersions(cwd, selection, config).flatMap((info) => info.tags);
      } else if (!selection || selection.includeUmbrella) {
        const project = resolveProject(cwd, ".", config.project);
        if (project.ecosystem !== "javascript" || project.versionFile === "VERSION") {
          const native = readProjectVersion(project);
          tags = [
            ...applicableProjectVersions(project, config.tag_prefix),
            ...(native ? [parseSemVer(native) as SemVer] : []),
          ];
        }
      }
      const bumpResult = options.version
        ? { ...customTierTags(options.version, needsRc, needsFinal), bumpType: "custom" as const }
        : options.bump
          ? { ...computeTierTags(tags, options.bump, needsRc, needsFinal), bumpType: options.bump }
          : await promptBumpType(tags, needsRc, needsFinal, cwd, config.tag_prefix);
      if (isBack(bumpResult)) {
        if (options.environments) return BACK;
        break;
      }
      if ((options.version || options.bump) && (!selection || config.type === "default")) {
        validateTierTags(bumpResult, tags, cwd, config.tag_prefix);
      }
      return {
        selectedEnvs,
        rcTag: bumpResult.rcTag,
        finalTag: bumpResult.finalTag,
        bumpType: bumpResult.bumpType,
        mergePairedEnv: options.environments ? false : undefined,
      };
    }
  }
}

interface RepoVersionInfo {
  key: string;
  label: string;
  isUmbrella: boolean;
  tags: SemVer[];
  latest: SemVer | null;
}

function gatherMetaRepoVersions(
  cwd: string,
  selection: SubprojectSelection,
  config: XEployConfig,
): RepoVersionInfo[] {
  const infos: RepoVersionInfo[] = [];

  if (selection.includeUmbrella) {
    const project = resolveProject(cwd, ".", config.project);
    const native = readProjectVersion(project);
    const tags = [
      ...applicableProjectVersions(project, config.tag_prefix),
      ...(native ? [parseSemVer(native) as SemVer] : []),
    ];
    infos.push({
      key: UMBRELLA_SELECTION,
      label: "Umbrella (this repo)",
      isUmbrella: true,
      tags,
      latest: getLatestTag(tags),
    });
  }

  initSubmodules(cwd);
  const byName = new Map(listSubmodules(cwd).map((sub) => [sub.name, sub]));
  for (const repo of selection.repos) {
    const sub = byName.get(repo);
    if (!sub) {
      continue;
    }
    const subPath = resolveSubmodulePath(cwd, sub.path);
    fetchTags(subPath);
    const project = resolveProject(subPath, ".", getSubprojectConfig(config, repo)?.project);
    const native = readProjectVersion(project);
    const tags = [
      ...applicableProjectVersions(project, config.tag_prefix),
      ...(native ? [parseSemVer(native) as SemVer] : []),
    ];
    infos.push({
      key: repo,
      label: repo,
      isUmbrella: false,
      tags,
      latest: getLatestTag(tags),
    });
  }

  return infos;
}

function gatherMonoRepoVersions(
  config: XEployConfig,
  cwd: string,
  selection: SubprojectSelection,
): RepoVersionInfo[] {
  const infos: RepoVersionInfo[] = [];

  if (selection.includeUmbrella) {
    const value = readProjectVersion(resolveProject(cwd, ".", config.project));
    const latest = value ? parseSemVer(value) : null;
    infos.push({
      key: UMBRELLA_SELECTION,
      label: "Umbrella (this repo)",
      isUmbrella: true,
      tags: latest ? [latest] : [],
      latest,
    });
  }

  if (config.type === "mono") {
    const enabled = new Set(getEnabledSubprojects(config).map((s) => s.repo));
    for (const repo of selection.repos) {
      if (!enabled.has(repo)) {
        continue;
      }
      const sub = getSubprojectConfig(config, repo);
      const value = readProjectVersion(
        resolveProject(
          cwd,
          sub?.path ?? path.join(config.subprojectsDir ?? ".", repo),
          sub?.project,
        ),
      );
      const latest = value ? parseSemVer(value) : null;
      infos.push({
        key: repo,
        label: repo,
        isUmbrella: false,
        tags: latest ? [latest] : [],
        latest,
      });
    }
  }

  return infos;
}

function versionsInconsistent(infos: RepoVersionInfo[]): boolean {
  const bases = infos.map((i) => (i.latest ? baseVersionString(i.latest) : "(none)"));
  return new Set(bases).size > 1;
}

function highestRepoVersion(infos: RepoVersionInfo[]): RepoVersionInfo {
  return infos.reduce((highest, info) => {
    if (!info.latest) {
      return highest;
    }
    if (!highest.latest) {
      return info;
    }
    return compareSemVer(info.latest, highest.latest) > 0 ? info : highest;
  });
}

/**
 * When selected repos have inconsistent latest versions, ask whether to bump
 * each repo from its own version or unify everything to the highest version.
 * Returns the plan possibly augmented with `perRepoTags` (separate) or with the
 * umbrella tags rewritten to the unified (highest-based) target.
 */
async function resolveRepoVersionConsistency(
  plan: ReleasePlan,
  config: XEployConfig,
  cwd: string,
  selection: SubprojectSelection,
  options: ReleaseOptions = {},
): Promise<ReleasePlan | typeof BACK> {
  if (config.type !== "meta" && config.type !== "mono") {
    return plan;
  }
  if (!plan.bumpType || plan.bumpType === "custom") {
    return plan;
  }
  if (selection.repos.length === 0) {
    return plan;
  }

  const needsRc = plan.selectedEnvs.some((e) => RC_ENVS.includes(e));
  const needsFinal = plan.selectedEnvs.some((e) => FINAL_ENVS.includes(e));

  const s = p.spinner();
  s.start("Checking repo versions");
  const infos =
    config.type === "meta"
      ? gatherMetaRepoVersions(cwd, selection, config)
      : gatherMonoRepoVersions(config, cwd, selection);
  s.stop("Repo versions checked");

  if (infos.length < 2 || !versionsInconsistent(infos)) {
    return plan;
  }

  const bumpType = plan.bumpType;
  const separate = infos.map((info) => ({
    info,
    tags: computeTierTags(info.tags, bumpType, needsRc, needsFinal),
  }));
  const unifyTags = computeTierTags(highestRepoVersion(infos).tags, bumpType, needsRc, needsFinal);

  const separateLabel = `Bump each version separately (${separate
    .map((e) => `${e.info.label}: ${displayTierTag(e.tags)}`)
    .join(", ")})`;
  const unifyLabel = `Unify them to ${displayTierTag(unifyTags)}`;

  const currentList = infos
    .map((i) => `${i.label}: ${i.latest ? formatSemVer(i.latest) : "(none)"}`)
    .join("\n");

  const choice = options.unify
    ? "unify"
    : cancelAsBack(
        await p.select<"separate" | "unify">({
          message: `The latest versions of selected repos are different:\n${currentList}\n\nHow would you like to bump?`,
          options: [
            { label: separateLabel, value: "separate" },
            { label: unifyLabel, value: "unify" },
          ],
        }),
      );
  if (isBack(choice)) {
    return BACK;
  }

  if (choice === "unify") {
    return {
      ...plan,
      rcTag: unifyTags.rcTag,
      finalTag: unifyTags.finalTag,
      perRepoTags: undefined,
    };
  }

  const perRepoTags: Record<string, RepoTierTags> = {};
  let umbrellaTags: RepoTierTags = { rcTag: plan.rcTag, finalTag: plan.finalTag };
  for (const entry of separate) {
    if (entry.info.isUmbrella) {
      umbrellaTags = entry.tags;
    } else {
      perRepoTags[entry.info.key] = entry.tags;
    }
  }

  return {
    ...plan,
    rcTag: umbrellaTags.rcTag,
    finalTag: umbrellaTags.finalTag,
    perRepoTags,
  };
}

function monoFileVersionsForTier(
  config: XEployConfig,
  plan: ReleasePlan,
  tier: "rc" | "final",
  cwd: string,
): Record<string, string> {
  const map: Record<string, string> = {};
  if (!plan.perRepoTags) {
    return map;
  }
  for (const [repo, tierTags] of Object.entries(plan.perRepoTags)) {
    const version = tier === "rc" ? tierTags.rcTag : tierTags.finalTag;
    if (!version) {
      continue;
    }
    const sub = getSubprojectConfig(config, repo);
    const project = resolveProject(
      cwd,
      sub?.path ?? path.join(config.subprojectsDir ?? ".", repo),
      sub?.project,
    );
    map[path.join(project.directory, project.versionFile)] = version;
  }
  return map;
}

async function preflightReleasePlan(
  plan: ReleasePlan,
  config: XEployConfig,
  cwd: string,
  tags: SemVer[],
  options?: { skipSummary?: boolean },
): Promise<true | typeof BACK> {
  const branch = currentBranch(cwd);
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartRc = latest ? formatGitTag(latest, config.tag_prefix) : null;
  const notesStartFinal = latestFinal ? formatGitTag(latestFinal, config.tag_prefix) : null;

  if (!options?.skipSummary) {
    const summaryLines: string[] = [];
    if (plan.rcTag) {
      summaryLines.push(releaseNote(toGitTag(plan.rcTag, config.tag_prefix), notesStartRc, true));
    }
    if (plan.finalTag) {
      summaryLines.push(
        releaseNote(toGitTag(plan.finalTag, config.tag_prefix), notesStartFinal, false),
      );
    }
    summaryLines.push(`Branch: ${branch}`);
    summaryLines.push(`Environments: ${plan.selectedEnvs.join(", ")}`);
    const primaryEnv = plan.selectedEnvs[0];
    if (primaryEnv) {
      const pairedEnv = getPairedReleaseEnv(primaryEnv);
      if (pairedEnv && plan.mergePairedEnv !== undefined) {
        const scope = config.type === "meta" || config.type === "mono" ? " (all repos)" : "";
        summaryLines.push(
          `Also sync to ${pairedEnv}: ${plan.mergePairedEnv ? "yes" : "no"}${scope}`,
        );
      }
    }
    if (config.type === "meta") {
      summaryLines.push("Mode: meta (submodules serial, then umbrella)");
    }

    if (plan.perRepoTags && Object.keys(plan.perRepoTags).length > 0) {
      const perRepoLines = Object.entries(plan.perRepoTags).map(
        ([repo, tierTags]) => `  ${repo}: ${displayTierTag(tierTags)}`,
      );
      summaryLines.push(["Per-repo versions (separate bump):", ...perRepoLines].join("\n"));
    }

    p.note(summaryLines.join("\n\n"), "Release summary");
  }

  const ok = cancelAsBack(await p.confirm({ message: "Proceed?", initialValue: true }));
  if (isBack(ok)) {
    return BACK;
  }
  if (!ok) {
    abort();
  }

  requireCleanTree(cwd, { allowOnly: [CONFIG_FILE] });
  return true;
}

export async function runReleaseTier(opts: {
  tag: string;
  prerelease: boolean;
  envs: ReleaseEnv[];
  versionFiles: string[];
  notesStartTag: string | null;
  branch: string;
  config: XEployConfig;
  cwd: string;
  metaOverride?: SubprojectConfig;
  includeConfigIfDirty?: boolean;
  mergePairedEnv?: boolean;
  skipSyncConfirm?: boolean;
  fileVersions?: Record<string, string>;
  projects?: ProjectDescriptor[];
  prepared?: PreparedRepositoryVersions;
  journalRoot?: string;
}): Promise<void> {
  const tagPrefix = opts.config.tag_prefix;
  const createTag = getCreateTag(opts.config, opts.metaOverride);

  if (opts.envs.length === 0) {
    return;
  }

  const s = p.spinner();
  s.start(`Bumping version to ${opts.tag}`);
  await releaseStep(opts.journalRoot, opts.cwd, `${opts.tag}/versions`, () => {
    bumpVersionFiles(opts.tag, opts.versionFiles, opts.cwd, {
      includeConfigIfDirty: opts.includeConfigIfDirty,
      fileVersions: opts.fileVersions,
      projects: opts.projects,
      edits: opts.prepared?.edits,
      push: false,
      allowApplied: Boolean(opts.journalRoot),
    });
  });
  await releaseStep(opts.journalRoot, opts.cwd, `${opts.tag}/push`, () =>
    pushBranch(opts.branch, opts.cwd),
  );
  s.stop("Version bumped, committed, and pushed");

  if (createTag) {
    await releaseStep(opts.journalRoot, opts.cwd, `${opts.tag}/release`, () => {
      createModuleTags(
        opts.cwd,
        opts.prepared?.moduleTags ??
          (opts.projects ?? [])
            .filter((project) => project.ecosystem === "go")
            .map((project) =>
              goModuleTag(
                project,
                opts.fileVersions?.[path.join(project.directory, project.versionFile)] ?? opts.tag,
              ),
            ),
      );
      s.start(`Creating ${opts.prerelease ? "pre-" : ""}release ${toGitTag(opts.tag, tagPrefix)}`);
      createRelease({
        tag: opts.tag,
        prerelease: opts.prerelease,
        notesStartTag: opts.notesStartTag,
        branch: opts.branch,
        generateReleaseNotes: opts.config.generate_release_notes,
        tagPrefix,
        cwd: opts.cwd,
        reuseExisting: Boolean(opts.journalRoot),
      });
    });
    s.stop(`Release ${toGitTag(opts.tag, tagPrefix)} created`);
  } else {
    p.log.info(`Skipping tag creation for ${toGitTag(opts.tag, tagPrefix)} (create_tag: false)`);
  }

  for (const env of opts.envs) {
    await releaseStep(opts.journalRoot, opts.cwd, `${opts.tag}/env/${env}`, () =>
      handleEnvPostRelease({
        env,
        tag: opts.tag,
        config: opts.config,
        branch: opts.branch,
        metaOverride: opts.metaOverride,
        cwd: opts.cwd,
        skipSyncConfirm: opts.skipSyncConfirm,
      }),
    );

    const pairedEnv = getPairedReleaseEnv(env);
    if (!pairedEnv || opts.mergePairedEnv === false || opts.envs.includes(pairedEnv)) {
      continue;
    }

    if (!isPairedEnvEnabled(opts.config, pairedEnv, opts.metaOverride)) {
      continue;
    }

    const pairedBranch = getMetaEnvBranch(opts.config, pairedEnv, opts.metaOverride);
    if (!pairedBranch) {
      continue;
    }

    const branchReady = await ensureRemoteEnvBranch({
      branchName: pairedBranch,
      fromBranch: opts.branch,
      env: pairedEnv,
      cwd: opts.cwd,
    });
    if (!branchReady) {
      continue;
    }

    const mergePaired =
      opts.mergePairedEnv !== undefined
        ? opts.mergePairedEnv
        : await promptMergePairedEnv(pairedEnv, opts.config, opts.metaOverride);
    if (!mergePaired) {
      continue;
    }

    await releaseStep(opts.journalRoot, opts.cwd, `${opts.tag}/env/${pairedEnv}`, () =>
      handleEnvPostRelease({
        env: pairedEnv,
        tag: opts.tag,
        config: opts.config,
        branch: opts.branch,
        metaOverride: opts.metaOverride,
        cwd: opts.cwd,
        skipSyncConfirm: opts.skipSyncConfirm,
      }),
    );
  }
}

/** Freeze the complete selected graph, including sequential RC/final native values. */
export function prepareReleaseGraph(
  plan: ReleasePlan,
  config: XEployConfig,
  cwd: string,
  selection?: SubprojectSelection,
): void {
  if (!plan.selectedEnvs.length) throw new Error("Select at least one release environment");
  for (const tag of [plan.rcTag, plan.finalTag]) if (tag) assertReleaseVersion(tag);
  const repositories =
    config.type === "meta"
      ? listSubmodules(cwd).filter(
          (sub) =>
            getSubprojectConfig(config, sub.name)?.enabled !== false &&
            (!selection || selection.repos.includes(sub.name)),
        )
      : [];
  const preparedVersions: NonNullable<ReleasePlan["preparedVersions"]> = {};
  plan.preparedVersions = preparedVersions;
  const snapshots = new Map<string, Map<string, string | null>>();
  const prepareTier = (
    directoryRoot: string,
    localConfig: XEployConfig,
    version: string,
    tier: "rc" | "final",
    localSelection?: SubprojectSelection,
    overrides?: Record<string, string>,
  ) => {
    const root = path.resolve(directoryRoot);
    validateTierTags(
      { rcTag: tier === "rc" ? version : null, finalTag: tier === "final" ? version : null },
      [],
      root,
      localConfig.tag_prefix,
    );
    const snapshot = snapshots.get(root) ?? new Map<string, string | null>();
    snapshots.set(root, snapshot);
    const prepared = prepareRepositoryVersions(
      localConfig,
      root,
      version,
      localSelection,
      overrides,
      1,
      new Map(snapshot),
    );
    const repoPlan = preparedVersions;
    repoPlan[root] ??= {};
    const tiers = repoPlan[root];
    if (tiers) tiers[tier] = prepared;
    for (const edit of prepared.edits) snapshot.set(edit.path, edit.after);
    return prepared;
  };
  for (const tier of ["rc", "final"] as const) {
    const version = tier === "rc" ? plan.rcTag : plan.finalTag;
    if (!version) continue;
    if (config.type !== "meta" || !selection || selection.includeUmbrella) {
      const prepared = prepareTier(
        cwd,
        config,
        version,
        tier,
        selection,
        config.type === "mono" ? monoFileVersionsForTier(config, plan, tier, cwd) : undefined,
      );
      if (prepared.edits.length)
        p.note(
          prepared.edits
            .map((edit) => {
              const changes = edit.changes
                ?.filter((change) => change.value !== change.replacement)
                .map(
                  (change) => `${change.value || "(empty)"} → ${change.replacement || "(empty)"}`,
                )
                .join(", ");
              return `${edit.path}${changes ? `: ${changes}` : ""}`;
            })
            .concat(prepared.moduleTags.map((tag) => `Go tag: ${tag}`))
            .join("\n"),
          `Version files (${version})`,
        );
    }
    for (const sub of repositories) {
      const child = getSubprojectConfig(config, sub.name);
      const target =
        plan.perRepoTags?.[sub.name]?.[tier === "rc" ? "rcTag" : "finalTag"] ?? version;
      const childCwd = resolveSubmodulePath(cwd, sub.path);
      requireCleanTree(childCwd);
      if (currentBranch(childCwd) === "HEAD") {
        const branch = child?.environments?.develop ?? config.environments.develop ?? "develop";
        const head = run("git", ["rev-parse", "HEAD"], childCwd);
        const local = tryRun("git", ["rev-parse", "--verify", `refs/heads/${branch}`], childCwd);
        const remote = tryRun(
          "git",
          ["rev-parse", "--verify", `refs/remotes/origin/${branch}`],
          childCwd,
        );
        if ((local ?? remote) !== head)
          throw new Error(
            `Detached submodule ${sub.name}: check out the intended integration branch before releasing`,
          );
        plan.branchCheckouts ??= {};
        plan.branchCheckouts[path.resolve(childCwd)] = { branch, ref: head };
      }
      const prepared = prepareTier(
        childCwd,
        {
          ...config,
          type: "default",
          project: child?.project,
          create_tag: child?.create_tag ?? config.create_tag,
        },
        target,
        tier,
      );
      p.note(prepared.edits.map((edit) => edit.path).join("\n"), `${sub.name}: ${target}`);
    }
  }
}

export async function executeReleasePlan(
  plan: ReleasePlan,
  config: XEployConfig,
  cwd: string,
  tags: SemVer[],
  options?: {
    metaOverride?: SubprojectConfig;
    skipPreflight?: boolean;
    skipSummary?: boolean;
    submoduleRelPath?: string;
    repoRoot?: string;
    selection?: SubprojectSelection;
    skipSyncConfirm?: boolean;
  },
): Promise<void> {
  if (config.type === "meta" && !options?.submoduleRelPath && !plan.journalRoot) {
    requireCleanTree(cwd, { allowOnly: [CONFIG_FILE] });
    initSubmodules(cwd);
  }
  if (!plan.preparedVersions) {
    const localConfig = options?.submoduleRelPath
      ? {
          ...config,
          type: "default" as const,
          project: options.metaOverride?.project,
          create_tag: options.metaOverride?.create_tag ?? config.create_tag,
        }
      : config;
    prepareReleaseGraph(plan, localConfig, cwd, options?.selection);
  }
  if (!options?.skipPreflight) {
    if (
      isBack(
        await preflightReleasePlan(plan, config, cwd, tags, {
          skipSummary: options?.skipSummary,
        }),
      )
    )
      return;
  } else {
    const allowOnly = options?.submoduleRelPath ? undefined : [CONFIG_FILE];
    if (!plan.journalRoot) requireCleanTree(cwd, { allowOnly });
  }

  const ownsJournal = !plan.journalRoot;
  if (ownsJournal) beginReleaseJournal(plan, config, cwd, options?.selection);
  if (config.type === "meta" && !options?.submoduleRelPath) {
    await executePreparedGraph(plan, config, cwd, tags, options?.selection);
    return;
  }
  const repoRoot = options?.repoRoot ?? cwd;
  const preparedRepo = plan.preparedVersions?.[path.resolve(cwd)];
  const projects =
    preparedRepo?.rc?.projects ??
    preparedRepo?.final?.projects ??
    resolveProjects(config, repoRoot, options?.selection);
  const versionFiles = projects.map((project) => path.join(project.directory, project.versionFile));
  const metaOverride = options?.metaOverride;
  const branch = currentBranch(cwd);
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartRc = latest ? formatGitTag(latest, config.tag_prefix) : null;
  const notesStartFinal = latestFinal ? formatGitTag(latestFinal, config.tag_prefix) : null;

  const includeConfigIfDirty = !options?.submoduleRelPath;
  const rcEnvs = plan.selectedEnvs.filter((e) => isRcEnv(e));
  const finalEnvs = plan.selectedEnvs.filter((e) => !isRcEnv(e));

  // Mono project targets share one Git repo; meta children use their own target plan.
  const isMono = config.type === "mono" && !options?.submoduleRelPath;

  const tierOpts = {
    journalRoot: plan.journalRoot,
    mergePairedEnv: plan.mergePairedEnv,
    skipSyncConfirm: options?.skipSyncConfirm,
  };

  if (plan.rcTag) {
    await runReleaseTier({
      tag: plan.rcTag,
      prerelease: true,
      envs: rcEnvs,
      versionFiles,
      projects,
      prepared: plan.preparedVersions?.[path.resolve(cwd)]?.rc,
      notesStartTag: notesStartRc,
      branch,
      config,
      cwd,
      metaOverride,
      includeConfigIfDirty,
      fileVersions:
        isMono && !preparedRepo ? monoFileVersionsForTier(config, plan, "rc", cwd) : undefined,
      ...tierOpts,
    });
  }

  if (plan.finalTag) {
    await runReleaseTier({
      tag: plan.finalTag,
      prerelease: false,
      envs: finalEnvs,
      versionFiles,
      projects,
      prepared: plan.preparedVersions?.[path.resolve(cwd)]?.final,
      notesStartTag: notesStartFinal,
      branch,
      cwd,
      config,
      metaOverride,
      includeConfigIfDirty,
      fileVersions:
        isMono && !preparedRepo ? monoFileVersionsForTier(config, plan, "final", cwd) : undefined,
      ...tierOpts,
    });
  }
  if (ownsJournal) completeReleaseJournal(plan.journalRoot);
}

export async function handleEnvPostRelease(opts: {
  env: ReleaseEnv;
  tag: string;
  config: XEployConfig;
  branch: string;
  metaOverride?: SubprojectConfig;
  cwd: string;
  skipSyncConfirm?: boolean;
}): Promise<void> {
  const envBranch = getMetaEnvBranch(opts.config, opts.env, opts.metaOverride);
  if (!envBranch) {
    p.note(`Environment "${opts.env}" has no branch mapped — skipping.`, "Skipped");
    return;
  }

  const branchReady = await ensureRemoteEnvBranch({
    branchName: envBranch,
    fromBranch: opts.branch,
    env: opts.env,
    cwd: opts.cwd,
  });
  if (!branchReady) {
    return;
  }

  let sourceBranch = opts.branch;

  if (opts.env === "production" && opts.config.create_production_release_branch) {
    const releaseBranch = formatReleaseBranch(opts.tag, opts.config.tag_prefix);
    const s = p.spinner();
    s.start(`Creating release branch ${releaseBranch}`);
    try {
      createReleaseBranch(releaseBranch, opts.branch, opts.cwd);
      sourceBranch = releaseBranch;
      s.stop(`Release branch ${releaseBranch} created`);
    } catch (error) {
      s.stop("Failed to create release branch");
      throw new Error("Could not publish production release branch", { cause: error });
    }
  }

  const createPr = getCreatePr(opts.config, opts.env, opts.metaOverride);
  const createTag = getCreateTag(opts.config, opts.metaOverride);
  const prTitle = `Release ${opts.tag} → ${opts.env}`;

  if (createPr) {
    await mergeOrPr({
      envBranch,
      sourceBranch,
      tag: opts.tag,
      createPr: true,
      prTitle,
      checkoutBranch: opts.branch,
      tagPrefix: opts.config.tag_prefix,
      cwd: opts.cwd,
      skipSyncConfirm: opts.skipSyncConfirm,
      pushTagOnSync: createTag,
    });
  } else {
    await syncBranch(
      envBranch,
      opts.tag,
      sourceBranch,
      opts.cwd,
      opts.branch,
      opts.config.tag_prefix,
      opts.skipSyncConfirm,
      createTag,
    );
  }
}

export async function flowNewRelease(
  tagFetch: BackgroundTagFetch,
  config: XEployConfig,
  cwd: string,
  selection?: SubprojectSelection,
  options: ReleaseOptions = {},
): Promise<typeof BACK | undefined> {
  if (selection && !selection.includeUmbrella && selection.repos.length === 0) {
    p.log.info("No projects selected. Skipping release.");
    return;
  }
  if (selection) {
    const enabled = new Set(getEnabledSubprojects(config).map((sub) => sub.repo));
    for (const repo of selection.repos)
      if (!enabled.has(repo)) throw new Error(`Unknown or disabled project selected: ${repo}`);
  }
  if (config.type === "meta") {
    requireCleanTree(cwd, { allowOnly: [CONFIG_FILE] });
    initSubmodules(cwd);
  }
  await resolveTagsWithSpinner(tagFetch, cwd);
  const setup = await configureProjectSources(config, cwd, selection, options.version);
  if (isBack(setup)) return BACK;
  while (true) {
    let plan = await planRelease(config, tagFetch, cwd, options, selection);
    if (isBack(plan)) {
      return BACK;
    }

    if (selection) {
      const resolved = await resolveRepoVersionConsistency(plan, config, cwd, selection, options);
      if (isBack(resolved)) {
        if (options.version || options.bump || options.environments || options.unify) return BACK;
        continue;
      }
      plan = resolved;
    }

    // Check every selected repository before releasing any of them.
    if (config.type === "mono") validateTierTags(plan, [], cwd, config.tag_prefix);
    if (selection) {
      if (config.type === "meta") {
        const infos = gatherMetaRepoVersions(cwd, selection, config);
        const submodules = new Map(listSubmodules(cwd).map((sub) => [sub.name, sub]));
        for (const info of infos) {
          const sub = submodules.get(info.key);
          const repoCwd = info.isUmbrella ? cwd : resolveSubmodulePath(cwd, sub?.path ?? info.key);
          try {
            validateTierTags(
              plan.perRepoTags?.[info.key] ?? plan,
              info.tags,
              repoCwd,
              config.tag_prefix,
            );
          } catch (error) {
            throw new Error(
              `${info.label}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } else if (config.type === "mono" && options.version) {
        for (const info of gatherMonoRepoVersions(config, cwd, selection)) {
          try {
            validateTierTags(plan, info.tags, cwd, config.tag_prefix);
          } catch (error) {
            throw new Error(
              `${info.label}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }

    prepareReleaseGraph(plan, config, cwd, selection);

    const withMerge = await promptMergePairedEnvUpfront(plan, config, cwd, selection);
    if (isBack(withMerge)) {
      if (options.version || options.bump || options.environments || options.unify) return BACK;
      continue;
    }
    plan = withMerge;

    const tags = await resolveTagsWithSpinner(tagFetch, cwd);
    const preflight = await preflightReleasePlan(plan, config, cwd, tags);
    if (isBack(preflight)) {
      if (options.version || options.bump || options.environments || options.unify) return BACK;
      continue;
    }

    beginReleaseJournal(plan, config, cwd, selection);
    await executePreparedGraph(plan, config, cwd, tags, selection);
    return;
  }
}

export async function resumeRelease(cwd: string): Promise<void> {
  const journal = verifyReleaseResume(cwd);
  p.note(
    "Continuing the saved release; completed steps and counters will be reused.",
    "Release recovery",
  );
  await executePreparedGraph(journal.plan, journal.config, cwd, getTags(cwd), journal.selection);
}

async function executePreparedGraph(
  plan: ReleasePlan,
  config: XEployConfig,
  cwd: string,
  tags: SemVer[],
  selection?: SubprojectSelection,
): Promise<void> {
  for (const [root, source] of Object.entries(plan.branchCheckouts ?? {})) {
    await releaseStep(plan.journalRoot, root, "integration-checkout", () => {
      if (run("git", ["rev-parse", "HEAD"], root) !== source.ref)
        throw new Error(`Submodule source changed before checkout: ${root}`);
      runInherit("git", ["checkout", source.branch], root);
    });
  }
  if (plan.republishSources) {
    for (const [root, source] of Object.entries(plan.republishSources).reverse()) {
      await releaseStep(plan.journalRoot, root, `${source.version}/republish-delete`, () => {
        if (ghReleaseExists(source.version, root, config.tag_prefix))
          runInherit(
            "gh",
            ["release", "delete", toGitTag(source.version, config.tag_prefix), "--yes"],
            root,
          );
      });
      await releaseStep(plan.journalRoot, root, `${source.version}/republish-create`, () =>
        createRelease({
          tag: source.version,
          branch: `refs/tags/${toGitTag(source.version, config.tag_prefix)}`,
          prerelease: true,
          notesStartTag: null,
          generateReleaseNotes: config.generate_release_notes,
          tagPrefix: config.tag_prefix,
          cwd: root,
          reuseExisting: true,
        }),
      );
    }
    completeReleaseJournal(plan.journalRoot);
    return;
  }
  for (const [root, source] of Object.entries(plan.promotionSources ?? {})) {
    await releaseStep(plan.journalRoot, root, "promotion-checkout", () => {
      requireCleanTree(root);
      const existing = tryRun(
        "git",
        ["rev-parse", "--verify", `refs/heads/${source.branch}`],
        root,
      );
      if (existing && existing !== source.ref)
        throw new Error(`Historical release branch already exists: ${source.branch}`);
      runInherit(
        "git",
        existing ? ["checkout", source.branch] : ["checkout", "-b", source.branch, source.ref],
        root,
      );
    });
  }
  if (config.type === "meta") {
    const { runMetaRelease } = await import("./meta.js");
    // Finish each tier across the submodules and umbrella before starting the next.
    for (const tier of ["rc", "final"] as const) {
      const tierPlan: ReleasePlan = {
        ...plan,
        rcTag: tier === "rc" ? plan.rcTag : null,
        finalTag: tier === "final" ? plan.finalTag : null,
        selectedEnvs: plan.selectedEnvs.filter((env) => isRcEnv(env) === (tier === "rc")),
        perRepoTags: plan.perRepoTags
          ? Object.fromEntries(
              Object.entries(plan.perRepoTags).map(([repo, targets]) => [
                repo,
                {
                  rcTag: tier === "rc" ? targets.rcTag : null,
                  finalTag: tier === "final" ? targets.finalTag : null,
                },
              ]),
            )
          : undefined,
      };
      if (tierPlan.selectedEnvs.length > 0) {
        await runMetaRelease(tierPlan, config, cwd, tags, selection);
      }
    }
    await restorePromotionBranches(plan);
    completeReleaseJournal(plan.journalRoot);
    return;
  }

  await executeReleasePlan(plan, config, cwd, tags, {
    skipPreflight: true,
    skipSyncConfirm: true,
    selection,
  });
  await restorePromotionBranches(plan);
  completeReleaseJournal(plan.journalRoot);
  return;
}

async function restorePromotionBranches(plan: ReleasePlan): Promise<void> {
  for (const [root, source] of Object.entries(plan.promotionSources ?? {}).reverse()) {
    await releaseStep(plan.journalRoot, root, "promotion-restore", () =>
      runInherit("git", ["checkout", source.originalBranch], root),
    );
  }
}

export async function flowOldRelease(
  tagFetch: BackgroundTagFetch,
  config: XEployConfig,
  cwd: string,
): Promise<typeof BACK | undefined> {
  await resolveTagsWithSpinner(tagFetch, cwd);
  const tags = configuredTags(cwd, config.tag_prefix);
  const rcTags = getRcTags(tags);
  if (rcTags.length === 0) {
    p.cancel("No release candidate tags found.");
    process.exit(1);
  }

  while (true) {
    const chosen = cancelAsBack(
      await p.select<string>({
        message: "Select a previous RC release",
        options: rcTags.map((v) => ({
          label: formatSemVer(v),
          value: formatSemVer(v),
        })),
      }),
    );
    if (isBack(chosen)) {
      return BACK;
    }

    while (true) {
      const action = cancelAsBack(
        await p.select<"promote" | "republish">({
          message: `What to do with ${chosen}?`,
          options: [
            {
              label: `Promote to production  →  ${(chosen as string).replace(/-rc\.\d+$/, "")}  (final)`,
              value: "promote",
            },
            {
              label: `Re-publish as same RC  →  ${chosen}`,
              value: "republish",
            },
          ],
        }),
      );
      if (isBack(action)) {
        break;
      }

      if (action === "republish") {
        if (!config.create_tag) {
          p.log.warn("create_tag is false — re-publish requires tag creation.");
          continue;
        }

        const republish = prepareHistoricalRelease(chosen as string, config, cwd, true);
        p.note(
          `${Object.entries(republish.plan.republishSources ?? {})
            .map(
              ([root, source]) => `${root}: ${source.version} (existing tag, counters unchanged)`,
            )
            .join("\n")}\nExisting GitHub releases will be deleted and recreated.`,
          "Re-publish summary",
        );
        const ok = cancelAsBack(await p.confirm({ message: "Proceed?", initialValue: true }));
        if (isBack(ok)) break;
        if (!ok) abort();
        beginReleaseJournal(republish.plan, republish.config, cwd, republish.selection);
        await executePreparedGraph(
          republish.plan,
          republish.config,
          cwd,
          tags,
          republish.selection,
        );
        return;
      }

      const promotion = prepareHistoricalRelease(chosen as string, config, cwd);
      const result = await preflightReleasePlan(promotion.plan, promotion.config, cwd, tags);
      if (isBack(result)) break;
      beginReleaseJournal(promotion.plan, promotion.config, cwd, promotion.selection);
      await executePreparedGraph(promotion.plan, promotion.config, cwd, tags, promotion.selection);
      return;
    }
  }
}
