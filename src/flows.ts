import * as p from "@clack/prompts";
import type { CreatePrEnv, MetaRepoConfig, ReleaseEnv, XBumpConfig } from "./config.js";
import { FINAL_ENVS, RC_ENVS, isRcEnv } from "./config.js";
import {
  createRelease,
  createReleaseBranch,
  currentBranch,
  getLatestFinalTag,
  getLatestTag,
  getRcTags,
  ghReleaseExists,
  mergeOrPr,
  republishRc,
  requireCleanTree,
  syncBranch,
  tagExists,
} from "./git.js";
import { bumpVersion, compareSemVer, formatSemVer, parseSemVer } from "./semver.js";
import type { BumpType, SemVer } from "./semver.js";
import { bumpVersionFiles } from "./versions.js";

function abort(): never {
  p.cancel("Operation cancelled.");
  process.exit(0);
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

function getEnvBranch(config: XBumpConfig, env: ReleaseEnv): string | null {
  return config.environments[env];
}

function getCreatePr(
  config: XBumpConfig,
  env: CreatePrEnv,
  metaOverride?: MetaRepoConfig,
): boolean {
  if (metaOverride) {
    return metaOverride.create_pr[env];
  }
  return config.create_pr[env];
}

function getMetaEnvBranch(
  config: XBumpConfig,
  env: ReleaseEnv,
  metaOverride?: MetaRepoConfig,
): string | null {
  if (metaOverride) {
    return metaOverride.environments[env];
  }
  return config.environments[env];
}

async function promptBumpType(
  tags: SemVer[],
  needsRc: boolean,
  needsFinal: boolean,
): Promise<{ rcTag: string | null; finalTag: string | null }> {
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const latestStr = latest ? formatSemVer(latest) : "(none)";

  const rcOptions = needsRc
    ? [
        {
          label: `Release Candidate  →  ${formatSemVer(bumpVersion("rc", latest))}`,
          value: "rc" as BumpType,
        },
      ]
    : [];

  const baseForFinal = needsFinal && !needsRc ? latestFinal : latest;
  const baseStr = baseForFinal ? formatSemVer(baseForFinal) : "(none)";

  const bumpOptions = [
    ...rcOptions,
    {
      label: `Bug Fix            →  ${formatSemVer(bumpVersion("bugfix", baseForFinal))}`,
      value: "bugfix" as BumpType,
    },
    {
      label: `Minor              →  ${formatSemVer(bumpVersion("minor", baseForFinal))}`,
      value: "minor" as BumpType,
    },
    {
      label: `Major              →  ${formatSemVer(bumpVersion("major", baseForFinal))}`,
      value: "major" as BumpType,
    },
    { label: "Custom", value: "custom" as const },
  ];

  const bumpChoice = await p.select<BumpType | "custom">({
    message: `Select bump type  (current latest: ${needsFinal && !needsRc ? baseStr : latestStr})`,
    options: bumpOptions,
  });
  if (p.isCancel(bumpChoice)) {
    abort();
  }

  if (bumpChoice === "custom") {
    const customTag = await p.text({
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
        if (tagExists(v)) {
          return `Tag "${v}" already exists`;
        }
        const parsed = parseSemVer(v);
        if (parsed && latest && compareSemVer(parsed, latest) <= 0) {
          return `Version must be greater than current latest "${latestStr}"`;
        }
      },
    });
    if (p.isCancel(customTag)) {
      abort();
    }
    const parsed = parseSemVer(customTag as string);
    if (!parsed) {
      abort();
    }
    const rcTag = parsed.rc !== null ? (customTag as string) : null;
    const finalTag = parsed.rc === null ? (customTag as string) : formatSemVer(stripRc(parsed));
    return {
      rcTag: needsRc ? (rcTag ?? formatSemVer({ ...parsed, rc: parsed.rc ?? 1 })) : null,
      finalTag: needsFinal ? finalTag : null,
    };
  }

  const bumped = bumpVersion(bumpChoice as BumpType, baseForFinal);
  return {
    rcTag: needsRc ? formatSemVer(bumped) : null,
    finalTag: needsFinal ? formatSemVer(stripRc(bumped)) : null,
  };
}

export interface ReleasePlan {
  selectedEnvs: ReleaseEnv[];
  rcTag: string | null;
  finalTag: string | null;
}

export async function planRelease(tags: SemVer[]): Promise<ReleasePlan | null> {
  const selected = await p.multiselect<ReleaseEnv>({
    message: "Select release environments",
    options: [
      { label: "staging release   (RC)", value: "staging" },
      { label: "uat release       (RC)", value: "uat" },
      { label: "sandbox release   (final)", value: "sandbox" },
      { label: "production release (final)", value: "production" },
    ],
    required: true,
  });
  if (p.isCancel(selected) || selected.length === 0) {
    abort();
  }

  const needsRc = selected.some((e) => RC_ENVS.includes(e));
  const needsFinal = selected.some((e) => FINAL_ENVS.includes(e));
  const { rcTag, finalTag } = await promptBumpType(tags, needsRc, needsFinal);

  return { selectedEnvs: selected, rcTag, finalTag };
}

async function preflightReleasePlan(
  plan: ReleasePlan,
  config: XBumpConfig,
  cwd: string,
  tags: SemVer[],
  options?: { skipSummary?: boolean },
): Promise<void> {
  const branch = currentBranch(cwd);
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartRc = latest ? formatSemVer(latest) : null;
  const notesStartFinal = latestFinal ? formatSemVer(latestFinal) : null;

  if (!options?.skipSummary) {
    const summaryLines: string[] = [];
    if (plan.rcTag) {
      summaryLines.push(releaseNote(plan.rcTag, notesStartRc, true));
    }
    if (plan.finalTag) {
      summaryLines.push(releaseNote(plan.finalTag, notesStartFinal, false));
    }
    summaryLines.push(`Branch: ${branch}`);
    summaryLines.push(`Environments: ${plan.selectedEnvs.join(", ")}`);
    if (config.type === "meta") {
      summaryLines.push("Mode: meta (submodules parallel, then umbrella)");
    }

    p.note(summaryLines.join("\n\n"), "Release summary");
  }

  const ok = await p.confirm({ message: "Proceed?", initialValue: true });
  if (p.isCancel(ok) || !ok) {
    abort();
  }

  requireCleanTree(cwd);
}

export async function executeReleasePlan(
  plan: ReleasePlan,
  config: XBumpConfig,
  cwd: string,
  tags: SemVer[],
  options?: {
    metaOverride?: MetaRepoConfig;
    skipPreflight?: boolean;
    skipSummary?: boolean;
  },
): Promise<void> {
  if (!options?.skipPreflight) {
    await preflightReleasePlan(plan, config, cwd, tags, {
      skipSummary: options?.skipSummary,
    });
  } else {
    requireCleanTree(cwd);
  }

  const metaOverride = options?.metaOverride;
  const branch = currentBranch(cwd);
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartRc = latest ? formatSemVer(latest) : null;
  const notesStartFinal = latestFinal ? formatSemVer(latestFinal) : null;

  const rcEnvs = plan.selectedEnvs.filter((e) => isRcEnv(e));
  const finalEnvs = plan.selectedEnvs.filter((e) => !isRcEnv(e));

  if (plan.rcTag && rcEnvs.length > 0) {
    const s = p.spinner();
    s.start(`Bumping version to ${plan.rcTag}`);
    bumpVersionFiles(plan.rcTag, config.versionFiles, cwd);
    s.stop("Version bumped and committed");

    s.start(`Creating pre-release ${plan.rcTag}`);
    createRelease({
      tag: plan.rcTag,
      prerelease: true,
      notesStartTag: notesStartRc,
      branch,
      generateReleaseNotes: config.generate_release_notes,
      cwd,
    });
    s.stop(`Release ${plan.rcTag} created`);

    for (const env of rcEnvs) {
      await handleEnvPostRelease({
        env,
        tag: plan.rcTag,
        config,
        branch,
        metaOverride,
        cwd,
      });
    }
  }

  if (plan.finalTag && finalEnvs.length > 0) {
    const s = p.spinner();
    s.start(`Bumping version to ${plan.finalTag}`);
    bumpVersionFiles(plan.finalTag, config.versionFiles, cwd);
    s.stop("Version bumped and committed");

    s.start(`Creating final release ${plan.finalTag}`);
    createRelease({
      tag: plan.finalTag,
      prerelease: false,
      notesStartTag: notesStartFinal,
      branch,
      generateReleaseNotes: config.generate_release_notes,
      cwd,
    });
    s.stop(`Release ${plan.finalTag} created`);

    for (const env of finalEnvs) {
      await handleEnvPostRelease({
        env,
        tag: plan.finalTag,
        config,
        branch,
        metaOverride,
        cwd,
      });
    }
  }
}

export async function handleEnvPostRelease(opts: {
  env: ReleaseEnv;
  tag: string;
  config: XBumpConfig;
  branch: string;
  metaOverride?: MetaRepoConfig;
  cwd: string;
}): Promise<void> {
  const envBranch = getMetaEnvBranch(opts.config, opts.env, opts.metaOverride);
  if (!envBranch) {
    p.note(`Environment "${opts.env}" has no branch mapped — skipping.`, "Skipped");
    return;
  }

  let sourceBranch = opts.branch;

  if (opts.env === "production" && opts.config.create_production_release_branch) {
    const releaseBranch = `release/${opts.tag}`;
    const s = p.spinner();
    s.start(`Creating release branch ${releaseBranch}`);
    try {
      createReleaseBranch(releaseBranch, opts.branch, opts.cwd);
      sourceBranch = releaseBranch;
      s.stop(`Release branch ${releaseBranch} created`);
    } catch {
      s.stop("Failed to create release branch");
      p.log.error("Could not create release branch. Continuing with current branch.");
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
      cwd: opts.cwd,
    });
  } else {
    await syncBranch(envBranch, opts.tag, sourceBranch, opts.cwd);
  }
}

export async function flowNewRelease(
  tags: SemVer[],
  config: XBumpConfig,
  cwd: string,
): Promise<void> {
  const plan = await planRelease(tags);
  if (!plan) {
    return;
  }

  await preflightReleasePlan(plan, config, cwd, tags);

  if (config.type === "meta") {
    const { runMetaRelease } = await import("./meta.js");
    await runMetaRelease(plan, config, cwd, tags);
    return;
  }

  await executeReleasePlan(plan, config, cwd, tags, { skipPreflight: true });
}

export async function flowOldRelease(
  tags: SemVer[],
  config: XBumpConfig,
  cwd: string,
): Promise<void> {
  const rcTags = getRcTags(tags);
  if (rcTags.length === 0) {
    p.cancel("No release candidate tags found.");
    process.exit(1);
  }

  const chosen = await p.select<string>({
    message: "Select a previous RC release",
    options: rcTags.map((v) => ({ label: formatSemVer(v), value: formatSemVer(v) })),
  });
  if (p.isCancel(chosen)) {
    abort();
  }

  const action = await p.select<"promote" | "republish">({
    message: `What to do with ${chosen}?`,
    options: [
      {
        label: `Promote to production  →  ${(chosen as string).replace(/-rc\.\d+$/, "")}  (final)`,
        value: "promote",
      },
      { label: `Re-publish as same RC  →  ${chosen}`, value: "republish" },
    ],
  });
  if (p.isCancel(action)) {
    abort();
  }

  if (action === "republish") {
    const alreadyExists = ghReleaseExists(chosen as string, cwd);
    p.note(
      [
        `Tag: ${chosen}  (pre-release, unchanged)`,
        alreadyExists ? "Existing GitHub release will be deleted and re-created." : "",
      ]
        .filter(Boolean)
        .join("\n"),
      "Re-publish summary",
    );
    const ok = await p.confirm({ message: "Proceed?", initialValue: true });
    if (p.isCancel(ok) || !ok) {
      abort();
    }
    const s = p.spinner();
    s.start(`Re-publishing ${chosen}`);
    republishRc(chosen as string, {
      generateReleaseNotes: config.generate_release_notes,
      cwd,
    });
    s.stop(`Re-published ${chosen}`);
    return;
  }

  const parsed = parseSemVer(chosen as string);
  if (!parsed) {
    p.cancel("Invalid tag selected.");
    process.exit(1);
  }
  const finalVer: SemVer = { ...parsed, rc: null };
  const finalTag = formatSemVer(finalVer);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartTag = latestFinal ? formatSemVer(latestFinal) : null;
  const branch = currentBranch(cwd);
  const productionBranch = config.environments.production;

  p.note(
    [
      `Source RC:   ${chosen}`,
      releaseNote(finalTag, notesStartTag, false),
      `Branch:      ${branch}`,
      `Version files: ${config.versionFiles.join(", ")}`,
    ].join("\n"),
    "Promote summary",
  );

  const ok = await p.confirm({ message: "Proceed?", initialValue: true });
  if (p.isCancel(ok) || !ok) {
    abort();
  }

  requireCleanTree(cwd);

  const s = p.spinner();
  s.start(`Bumping version to ${finalTag}`);
  bumpVersionFiles(finalTag, config.versionFiles, cwd);
  s.stop("Version bumped and committed");

  s.start(`Creating final release ${finalTag}`);
  createRelease({
    tag: finalTag,
    prerelease: false,
    notesStartTag,
    branch,
    generateReleaseNotes: config.generate_release_notes,
    cwd,
  });
  s.stop(`Release ${finalTag} created`);

  if (productionBranch) {
    let sourceBranch = branch;
    if (config.create_production_release_branch) {
      const releaseBranch = `release/${finalTag}`;
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
        cwd,
      });
    } else {
      await syncBranch(productionBranch, finalTag, sourceBranch, cwd);
    }
  }
}
