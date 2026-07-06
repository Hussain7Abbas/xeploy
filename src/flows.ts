import * as p from "@clack/prompts";
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
  getEnabledSubprojects,
  RC_ENVS,
  getConfiguredReleaseEnvs,
  isRcEnv,
  resolveVersionFiles,
} from "./config.js";
import {
  createRelease,
  createReleaseBranch,
  currentBranch,
  getLatestFinalTag,
  getLatestRcTag,
  getLatestTag,
  getRcTags,
  ghReleaseExists,
  mergeOrPr,
  republishRc,
  requireCleanTree,
  syncBranch,
  tagExists,
} from "./git.js";
import { BACK, abort, cancelAsBack, isBack } from "./prompts-util.js";
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
import { bumpVersionFiles } from "./versions.js";

function releaseNote(
  tag: string,
  notesStart: string | null,
  prerelease: boolean,
): string {
  return [
    `Tag:         ${tag}  (${prerelease ? "pre-release" : "final"})`,
    `Notes since: ${notesStart ?? "beginning of history"}`,
  ].join("\n");
}

function stripRc(version: SemVer): SemVer {
  return { ...version, rc: null };
}

function resolveBumpBase(
  tags: SemVer[],
  needsRc: boolean,
  needsFinal: boolean,
): SemVer | null {
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

function formatBumpPreview(
  bumped: SemVer,
  needsRc: boolean,
  needsFinal: boolean,
): string {
  if (needsFinal && !needsRc) {
    return formatSemVer(stripRc(bumped));
  }
  return formatSemVer(bumped);
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

async function promptBumpType(
  tags: SemVer[],
  needsRc: boolean,
  needsFinal: boolean,
  cwd: string,
  tagPrefix: string,
): Promise<{ rcTag: string | null; finalTag: string | null } | typeof BACK> {
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
      const compareBase = baseForBump ?? latest;
      const compareStr = compareBase ? formatSemVer(compareBase) : "(none)";

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
              if (!/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(v)) {
                return "Format must be X.Y.Z or X.Y.Z-rc.N";
              }
              if (tagExists(v, cwd, tagPrefix)) {
                return `Tag "${toGitTag(v, tagPrefix)}" already exists`;
              }
              const parsed = parseSemVer(v);
              if (
                parsed &&
                compareBase &&
                compareSemVer(parsed, compareBase) <= 0
              ) {
                return `Version must be greater than current latest "${compareStr}"`;
              }
            },
          }),
        );
        if (isBack(customTag)) {
          break;
        }
        const parsed = parseSemVer(customTag as string);
        if (!parsed) {
          abort();
        }
        const rcTag = parsed.rc !== null ? (customTag as string) : null;
        const finalTag =
          parsed.rc === null
            ? (customTag as string)
            : formatSemVer(stripRc(parsed));
        return {
          rcTag: needsRc
            ? (rcTag ?? formatSemVer({ ...parsed, rc: parsed.rc ?? 1 }))
            : null,
          finalTag: needsFinal ? finalTag : null,
        };
      }
      continue;
    }

    const bumped = bumpVersion(bumpChoice as BumpType, baseForBump);
    return {
      rcTag: needsRc ? formatSemVer(bumped) : null,
      finalTag: needsFinal ? formatSemVer(stripRc(bumped)) : null,
    };
  }
}

export interface ReleasePlan {
  selectedEnvs: ReleaseEnv[];
  rcTag: string | null;
  finalTag: string | null;
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

async function promptMergePairedEnv(
  pairedEnv: ReleaseEnv,
  config: XEployConfig,
  metaOverride?: SubprojectConfig,
): Promise<boolean> {
  const createPr = getCreatePr(config, pairedEnv, metaOverride);
  const message = createPr
    ? `Open PR into ${pairedEnv}?`
    : `Also merge into ${pairedEnv}?`;

  const merge = await p.confirm({
    message,
    initialValue: false,
  });
  if (p.isCancel(merge)) {
    abort();
  }
  return merge;
}

export async function planRelease(
  config: XEployConfig,
  tags: SemVer[],
  cwd: string,
): Promise<ReleasePlan | typeof BACK> {
  const availableEnvs = getConfiguredReleaseEnvs(config);
  if (availableEnvs.length === 0) {
    p.cancel("No release environments configured in .xeploy.json.");
    process.exit(1);
  }

  while (true) {
    const selected = cancelAsBack(
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

    const needsRc = RC_ENVS.includes(selected);
    const needsFinal = FINAL_ENVS.includes(selected);

    while (true) {
      const bumpResult = await promptBumpType(tags, needsRc, needsFinal, cwd, config.tag_prefix);
      if (isBack(bumpResult)) {
        break;
      }
      return {
        selectedEnvs: [selected],
        rcTag: bumpResult.rcTag,
        finalTag: bumpResult.finalTag,
      };
    }
  }
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
  const notesStartFinal = latestFinal
    ? formatGitTag(latestFinal, config.tag_prefix)
    : null;

  if (!options?.skipSummary) {
    const summaryLines: string[] = [];
    if (plan.rcTag) {
      summaryLines.push(
        releaseNote(toGitTag(plan.rcTag, config.tag_prefix), notesStartRc, true),
      );
    }
    if (plan.finalTag) {
      summaryLines.push(
        releaseNote(toGitTag(plan.finalTag, config.tag_prefix), notesStartFinal, false),
      );
    }
    summaryLines.push(`Branch: ${branch}`);
    summaryLines.push(`Environments: ${plan.selectedEnvs.join(", ")}`);
    if (config.type === "meta") {
      summaryLines.push("Mode: meta (submodules serial, then umbrella)");
    }

    p.note(summaryLines.join("\n\n"), "Release summary");
  }

  const ok = cancelAsBack(
    await p.confirm({ message: "Proceed?", initialValue: true }),
  );
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
}): Promise<void> {
  const tagPrefix = opts.config.tag_prefix;

  if (opts.envs.length === 0) {
    return;
  }

  const s = p.spinner();
  s.start(`Bumping version to ${opts.tag}`);
  bumpVersionFiles(opts.tag, opts.versionFiles, opts.cwd, {
    includeConfigIfDirty: opts.includeConfigIfDirty,
  });
  s.stop("Version bumped, committed, and pushed");

  s.start(`Creating ${opts.prerelease ? "pre-" : ""}release ${toGitTag(opts.tag, tagPrefix)}`);
  createRelease({
    tag: opts.tag,
    prerelease: opts.prerelease,
    notesStartTag: opts.notesStartTag,
    branch: opts.branch,
    generateReleaseNotes: opts.config.generate_release_notes,
    tagPrefix,
    cwd: opts.cwd,
  });
  s.stop(`Release ${toGitTag(opts.tag, tagPrefix)} created`);

  for (const env of opts.envs) {
    await handleEnvPostRelease({
      env,
      tag: opts.tag,
      config: opts.config,
      branch: opts.branch,
      metaOverride: opts.metaOverride,
      cwd: opts.cwd,
    });

    const pairedEnv = getPairedReleaseEnv(env);
    if (!pairedEnv) {
      continue;
    }

    const pairedBranch = getMetaEnvBranch(
      opts.config,
      pairedEnv,
      opts.metaOverride,
    );
    if (!pairedBranch) {
      continue;
    }

    const mergePaired = await promptMergePairedEnv(
      pairedEnv,
      opts.config,
      opts.metaOverride,
    );
    if (!mergePaired) {
      continue;
    }

    await handleEnvPostRelease({
      env: pairedEnv,
      tag: opts.tag,
      config: opts.config,
      branch: opts.branch,
      metaOverride: opts.metaOverride,
      cwd: opts.cwd,
    });
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
  },
): Promise<void> {
  if (!options?.skipPreflight) {
    await preflightReleasePlan(plan, config, cwd, tags, {
      skipSummary: options?.skipSummary,
    });
  } else {
    const allowOnly = options?.submoduleRelPath ? undefined : [CONFIG_FILE];
    requireCleanTree(cwd, { allowOnly });
  }

  const repoRoot = options?.repoRoot ?? cwd;
  const versionFiles = options?.submoduleRelPath
    ? ["package.json"]
    : resolveVersionFiles(config, repoRoot, options?.selection);
  const metaOverride = options?.metaOverride;
  const branch = currentBranch(cwd);
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartRc = latest ? formatGitTag(latest, config.tag_prefix) : null;
  const notesStartFinal = latestFinal
    ? formatGitTag(latestFinal, config.tag_prefix)
    : null;

  const includeConfigIfDirty = !options?.submoduleRelPath;
  const rcEnvs = plan.selectedEnvs.filter((e) => isRcEnv(e));
  const finalEnvs = plan.selectedEnvs.filter((e) => !isRcEnv(e));

  if (plan.rcTag) {
    await runReleaseTier({
      tag: plan.rcTag,
      prerelease: true,
      envs: rcEnvs,
      versionFiles,
      notesStartTag: notesStartRc,
      branch,
      config,
      cwd,
      metaOverride,
      includeConfigIfDirty,
    });
  }

  if (plan.finalTag) {
    await runReleaseTier({
      tag: plan.finalTag,
      prerelease: false,
      envs: finalEnvs,
      versionFiles,
      notesStartTag: notesStartFinal,
      branch,
      config,
      cwd,
      metaOverride,
      includeConfigIfDirty,
    });
  }
}

export async function handleEnvPostRelease(opts: {
  env: ReleaseEnv;
  tag: string;
  config: XEployConfig;
  branch: string;
  metaOverride?: SubprojectConfig;
  cwd: string;
}): Promise<void> {
  const envBranch = getMetaEnvBranch(opts.config, opts.env, opts.metaOverride);
  if (!envBranch) {
    p.note(
      `Environment "${opts.env}" has no branch mapped — skipping.`,
      "Skipped",
    );
    return;
  }

  let sourceBranch = opts.branch;

  if (
    opts.env === "production" &&
    opts.config.create_production_release_branch
  ) {
    const releaseBranch = formatReleaseBranch(opts.tag, opts.config.tag_prefix);
    const s = p.spinner();
    s.start(`Creating release branch ${releaseBranch}`);
    try {
      createReleaseBranch(releaseBranch, opts.branch, opts.cwd);
      sourceBranch = releaseBranch;
      s.stop(`Release branch ${releaseBranch} created`);
    } catch {
      s.stop("Failed to create release branch");
      p.log.error(
        "Could not create release branch. Continuing with current branch.",
      );
    }
  }

  const createPr = getCreatePr(opts.config, opts.env, opts.metaOverride);
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
    });
  } else {
    await syncBranch(
      envBranch,
      opts.tag,
      sourceBranch,
      opts.cwd,
      opts.branch,
      opts.config.tag_prefix,
    );
  }
}

export async function flowNewRelease(
  tags: SemVer[],
  config: XEployConfig,
  cwd: string,
  selection?: SubprojectSelection,
): Promise<typeof BACK | undefined> {
  while (true) {
    const plan = await planRelease(config, tags, cwd);
    if (isBack(plan)) {
      return BACK;
    }

    const preflight = await preflightReleasePlan(plan, config, cwd, tags);
    if (isBack(preflight)) {
      continue;
    }

    if (config.type === "meta") {
      const { runMetaRelease } = await import("./meta.js");
      await runMetaRelease(plan, config, cwd, tags, selection);
      return;
    }

    await executeReleasePlan(plan, config, cwd, tags, {
      skipPreflight: true,
      selection,
    });
    return;
  }
}

export async function flowOldRelease(
  tags: SemVer[],
  config: XEployConfig,
  cwd: string,
): Promise<typeof BACK | undefined> {
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
        const alreadyExists = ghReleaseExists(chosen as string, cwd, config.tag_prefix);
        p.note(
          [
            `Tag: ${toGitTag(chosen as string, config.tag_prefix)}  (pre-release, unchanged)`,
            alreadyExists
              ? "Existing GitHub release will be deleted and re-created."
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
          "Re-publish summary",
        );

        while (true) {
          const ok = cancelAsBack(
            await p.confirm({ message: "Proceed?", initialValue: true }),
          );
          if (isBack(ok)) {
            break;
          }
          if (!ok) {
            abort();
          }
          const s = p.spinner();
          s.start(`Re-publishing ${toGitTag(chosen as string, config.tag_prefix)}`);
          republishRc(chosen as string, {
            generateReleaseNotes: config.generate_release_notes,
            tagPrefix: config.tag_prefix,
            cwd,
          });
          s.stop(`Re-published ${toGitTag(chosen as string, config.tag_prefix)}`);
          return;
        }
        continue;
      }

      const parsed = parseSemVer(chosen as string);
      if (!parsed) {
        p.cancel("Invalid tag selected.");
        process.exit(1);
      }
      const finalVer: SemVer = { ...parsed, rc: null };
      const finalTag = formatSemVer(finalVer);
      const latestFinal = getLatestFinalTag(tags);
      const notesStartTag = latestFinal
        ? formatGitTag(latestFinal, config.tag_prefix)
        : null;
      const branch = currentBranch(cwd);
      const productionBranch = config.environments.production;
      const versionFiles = resolveVersionFiles(config, cwd);

      p.note(
        [
          `Source RC:   ${chosen}`,
          releaseNote(finalTag, notesStartTag, false),
          `Branch:      ${branch}`,
          `Version files: ${versionFiles.join(", ")}`,
        ].join("\n"),
        "Promote summary",
      );

      while (true) {
        const ok = cancelAsBack(
          await p.confirm({ message: "Proceed?", initialValue: true }),
        );
        if (isBack(ok)) {
          break;
        }
        if (!ok) {
          abort();
        }

        requireCleanTree(cwd);

        const s = p.spinner();
        s.start(`Bumping version to ${finalTag}`);
        bumpVersionFiles(finalTag, versionFiles, cwd);
        s.stop("Version bumped, committed, and pushed");

        s.start(`Creating final release ${toGitTag(finalTag, config.tag_prefix)}`);
        createRelease({
          tag: finalTag,
          prerelease: false,
          notesStartTag,
          branch,
          generateReleaseNotes: config.generate_release_notes,
          tagPrefix: config.tag_prefix,
          cwd,
        });
        s.stop(`Release ${toGitTag(finalTag, config.tag_prefix)} created`);

        if (productionBranch) {
          let sourceBranch = branch;
          if (config.create_production_release_branch) {
            const releaseBranch = formatReleaseBranch(
              finalTag,
              config.tag_prefix,
            );
            const rs = p.spinner();
            rs.start(`Creating release branch ${releaseBranch}`);
            try {
              createReleaseBranch(releaseBranch, branch, cwd);
              sourceBranch = releaseBranch;
              rs.stop(`Release branch ${releaseBranch} created`);
            } catch {
              rs.stop("Failed to create release branch");
            }
          }

          if (config.create_pr.production) {
            await mergeOrPr({
              envBranch: productionBranch,
              sourceBranch,
              tag: finalTag,
              createPr: true,
              prTitle: `Release ${finalTag} → production`,
              checkoutBranch: branch,
              tagPrefix: config.tag_prefix,
              cwd,
            });
          } else {
            await syncBranch(
              productionBranch,
              finalTag,
              sourceBranch,
              cwd,
              branch,
              config.tag_prefix,
            );
          }
        }
        return;
      }
    }
  }
}
