import * as p from "@clack/prompts";
import type { X-DeployConfig } from "./config.js";
import { getMetaRepoConfig, isRcEnv, resolveVersionFiles } from "./config.js";
import type { ReleasePlan } from "./flows.js";
import { executeReleasePlan, runReleaseTier } from "./flows.js";
import {
  commitSubmodulePointers,
  currentBranch,
  fetchTags,
  getLatestFinalTag,
  getLatestTag,
  getTags,
  initSubmodules,
  listSubmodules,
} from "./git.js";
import { formatSemVer } from "./semver.js";
import type { SemVer } from "./semver.js";
import { resolveSubmodulePath } from "./validate.js";

export async function runMetaRelease(
  plan: ReleasePlan,
  config: X-DeployConfig,
  cwd: string,
  tags: SemVer[],
): Promise<void> {
  initSubmodules(cwd);
  const submodules = listSubmodules(cwd);

  if (submodules.length === 0) {
    p.log.warn("No submodules found. Running umbrella release only.");
    await executeReleasePlan(plan, config, cwd, tags);
    return;
  }

  p.log.info(`Running ${submodules.length} submodule releases serially...`);

  for (const sub of submodules) {
    const subPath = resolveSubmodulePath(cwd, sub.path);
    const metaConfig = getMetaRepoConfig(config, sub.name);

    p.log.step(`[${sub.name}] Starting release`);

    try {
      fetchTags(subPath);
      const subTags = getTags(subPath);

      await executeReleasePlan(plan, config, subPath, subTags, {
        metaOverride: metaConfig ?? undefined,
        skipPreflight: true,
        submoduleRelPath: sub.path,
        repoRoot: cwd,
      });

      p.log.success(`[${sub.name}] Release complete`);
    } catch (err) {
      p.log.error(`[${sub.name}] Release failed: ${String(err)}`);
      p.cancel("Submodule release failed. Umbrella release aborted.");
      process.exit(1);
    }
  }

  p.log.info("All submodule releases complete. Running umbrella release...");

  await runUmbrellaRelease(
    plan,
    config,
    cwd,
    tags,
    submodules.map((s) => s.path),
  );
}

async function runUmbrellaRelease(
  plan: ReleasePlan,
  config: X-DeployConfig,
  cwd: string,
  tags: SemVer[],
  submodulePaths: string[],
): Promise<void> {
  const branch = currentBranch(cwd);
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartRc = latest ? formatSemVer(latest) : null;
  const notesStartFinal = latestFinal ? formatSemVer(latestFinal) : null;
  const versionFiles = resolveVersionFiles(config, cwd);

  const rcEnvs = plan.selectedEnvs.filter((e) => isRcEnv(e));
  const finalEnvs = plan.selectedEnvs.filter((e) => !isRcEnv(e));

  if (plan.rcTag && rcEnvs.length > 0) {
    const s = p.spinner();
    s.start("Updating umbrella for RC release");
    commitSubmodulePointers(
      submodulePaths,
      `chore(release): bump submodules to ${plan.rcTag}`,
      cwd,
    );
    s.stop("Submodule pointers committed");

    await runReleaseTier({
      tag: plan.rcTag,
      prerelease: true,
      envs: rcEnvs,
      versionFiles,
      notesStartTag: notesStartRc,
      branch,
      config,
      cwd,
    });
  }

  if (plan.finalTag && finalEnvs.length > 0) {
    const s = p.spinner();
    s.start("Updating umbrella for final release");
    commitSubmodulePointers(
      submodulePaths,
      `chore(release): bump submodules to ${plan.finalTag}`,
      cwd,
    );
    s.stop("Submodule pointers committed");

    await runReleaseTier({
      tag: plan.finalTag,
      prerelease: false,
      envs: finalEnvs,
      versionFiles,
      notesStartTag: notesStartFinal,
      branch,
      config,
      cwd,
    });
  }
}
