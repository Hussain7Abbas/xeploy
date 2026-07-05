import * as p from "@clack/prompts";
import type { XBumpConfig } from "./config.js";
import { getMetaRepoConfig, isRcEnv } from "./config.js";
import type { ReleasePlan } from "./flows.js";
import { executeReleasePlan, handleEnvPostRelease } from "./flows.js";
import {
  commitSubmodulePointers,
  createRelease,
  currentBranch,
  getLatestFinalTag,
  getLatestTag,
  getTags,
  initSubmodules,
  listSubmodules,
} from "./git.js";
import { formatSemVer } from "./semver.js";
import type { SemVer } from "./semver.js";
import { bumpVersionFiles } from "./versions.js";

export async function runMetaRelease(
  plan: ReleasePlan,
  config: XBumpConfig,
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

  p.log.info(`Running ${submodules.length} submodule releases in parallel...`);

  const results = await Promise.allSettled(
    submodules.map(async (sub) => {
      const subPath = `${cwd}/${sub.path}`.replace(/\/+/g, "/");
      const metaConfig = getMetaRepoConfig(config, sub.name);
      const subTags = getTags(subPath);

      p.log.step(`[${sub.name}] Starting release`);

      await executeReleasePlan(plan, config, subPath, subTags, {
        metaOverride: metaConfig ?? undefined,
        skipPreflight: true,
      });

      p.log.success(`[${sub.name}] Release complete`);
      return sub.path;
    }),
  );

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    for (const f of failed) {
      if (f.status === "rejected") {
        p.log.error(String(f.reason));
      }
    }
    p.cancel("Some submodule releases failed. Umbrella release aborted.");
    process.exit(1);
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
  config: XBumpConfig,
  cwd: string,
  tags: SemVer[],
  submodulePaths: string[],
): Promise<void> {
  const branch = currentBranch(cwd);
  const latest = getLatestTag(tags);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartRc = latest ? formatSemVer(latest) : null;
  const notesStartFinal = latestFinal ? formatSemVer(latestFinal) : null;

  const rcEnvs = plan.selectedEnvs.filter((e) => isRcEnv(e));
  const finalEnvs = plan.selectedEnvs.filter((e) => !isRcEnv(e));
  const s = p.spinner();

  if (plan.rcTag && rcEnvs.length > 0) {
    s.start("Updating umbrella for RC release");
    commitSubmodulePointers(
      submodulePaths,
      `chore(release): bump submodules to ${plan.rcTag}`,
      cwd,
    );
    bumpVersionFiles(plan.rcTag, config.versionFiles, cwd);

    createRelease({
      tag: plan.rcTag,
      prerelease: true,
      notesStartTag: notesStartRc,
      branch,
      generateReleaseNotes: config.generate_release_notes,
      cwd,
    });
    s.stop(`Umbrella RC release ${plan.rcTag} created`);

    for (const env of rcEnvs) {
      await handleEnvPostRelease({
        env,
        tag: plan.rcTag,
        config,
        branch,
        cwd,
      });
    }
  }

  if (plan.finalTag && finalEnvs.length > 0) {
    s.start("Updating umbrella for final release");
    commitSubmodulePointers(
      submodulePaths,
      `chore(release): bump submodules to ${plan.finalTag}`,
      cwd,
    );
    bumpVersionFiles(plan.finalTag, config.versionFiles, cwd);

    createRelease({
      tag: plan.finalTag,
      prerelease: false,
      notesStartTag: notesStartFinal,
      branch,
      generateReleaseNotes: config.generate_release_notes,
      cwd,
    });
    s.stop(`Umbrella final release ${plan.finalTag} created`);

    for (const env of finalEnvs) {
      await handleEnvPostRelease({
        env,
        tag: plan.finalTag,
        config,
        branch,
        cwd,
      });
    }
  }
}
