import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SubprojectSelection, XEployConfig } from "./config.js";
import {
  getEnabledSubprojects,
  getSubprojectConfig,
  loadConfig,
  resolveProjects,
} from "./config.js";
import type { ReleasePlan } from "./flows.js";
import { currentBranch, listSubmodules, requireCleanTree, run, tagExists } from "./git.js";
import { prepareRepositoryVersions } from "./project-release.js";
import { readProjectVersion } from "./projects.js";
import { formatReleaseBranch, toGitTag } from "./semver.js";
import { assertReleaseVersion, resolveSubmodulePath } from "./validate.js";

/** Inspect disposable local checkouts, never current develop files, for an old RC. */
export function prepareHistoricalRelease(
  version: string,
  config: XEployConfig,
  cwd: string,
  republish = false,
): { plan: ReleasePlan; config: XEployConfig; selection: SubprojectSelection } {
  assertReleaseVersion(version);
  if (!/-rc\.\d+$/.test(version)) throw new Error("Promotion requires a release candidate");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "xeploy-history-"));
  const root = path.resolve(cwd);
  const finalTag = version.replace(/-rc\.\d+$/, "");
  const preparedVersions: NonNullable<ReleasePlan["preparedVersions"]> = {};
  const sources: NonNullable<ReleasePlan["promotionSources"]> = {};
  const clone = (actual: string, ref: string, name: string) => {
    const destination = path.join(scratch, name);
    run("git", ["clone", "--shared", "--no-checkout", "--", actual, destination]);
    run("git", ["checkout", "--detach", ref], destination);
    return destination;
  };
  const prepare = (
    actual: string,
    snapshot: string,
    ref: string,
    localConfig: XEployConfig,
    target: string,
    selection?: SubprojectSelection,
    overrides?: Record<string, string>,
  ) => {
    requireCleanTree(actual);
    if (!republish && tagExists(target, actual, config.tag_prefix))
      throw new Error(`Final release tag already exists in ${actual}: ${target}`);
    if (
      republish &&
      run(
        "git",
        ["rev-parse", `refs/tags/${toGitTag(target, config.tag_prefix)}^{commit}`],
        actual,
      ) !== ref
    )
      throw new Error(`Historical tag does not match the recorded commit in ${actual}`);
    const prepared = republish
      ? { projects: resolveProjects(localConfig, snapshot, selection), edits: [], moduleTags: [] }
      : prepareRepositoryVersions(localConfig, snapshot, target, selection, overrides);
    prepared.projects = prepared.projects.map((project) => ({
      ...project,
      root: actual,
      snapshot: undefined,
    }));
    preparedVersions[actual] = { final: prepared };
    sources[actual] = {
      ref,
      branch: formatReleaseBranch(target, config.tag_prefix),
      originalBranch: currentBranch(actual),
      version: target,
    };
  };
  try {
    const rootRef = run(
      "git",
      ["rev-parse", `refs/tags/${toGitTag(version, config.tag_prefix)}^{commit}`],
      root,
    );
    const snapshot = clone(root, rootRef, "umbrella");
    const historicalConfig = loadConfig(snapshot);
    // Historical paths and source bindings; current environment and publication policy.
    const releaseConfig = historicalConfig
      ? {
          ...config,
          type: historicalConfig.type,
          subprojectsDir: historicalConfig.subprojectsDir,
          project: historicalConfig.project,
          subprojects: historicalConfig.subprojects,
        }
      : config;
    const selection: SubprojectSelection = { includeUmbrella: true, repos: [] };
    const perRepoTags: NonNullable<ReleasePlan["perRepoTags"]> = {};
    const overrides: Record<string, string> = {};
    if (releaseConfig.type === "mono") {
      for (const sub of getEnabledSubprojects(releaseConfig)) {
        const descriptors = resolveProjects(releaseConfig, snapshot, {
          includeUmbrella: false,
          repos: [sub.repo],
        });
        const project = descriptors[0];
        const current = project && readProjectVersion(project);
        if (!project || !current?.includes("-rc.")) continue;
        const target = current.replace(/-rc\.\d+$/, "");
        selection.repos.push(sub.repo);
        perRepoTags[sub.repo] = { rcTag: null, finalTag: target };
        overrides[path.join(project.directory, project.versionFile)] = target;
      }
    }
    prepare(
      root,
      snapshot,
      rootRef,
      releaseConfig,
      republish ? version : finalTag,
      selection,
      overrides,
    );
    if (releaseConfig.type === "meta") {
      let snapshotIndex = 0;
      for (const sub of listSubmodules(snapshot)) {
        const settings = getSubprojectConfig(releaseConfig, sub.name);
        if (settings?.enabled === false) continue;
        const actual = resolveSubmodulePath(root, sub.path);
        const entry = run("git", ["ls-tree", rootRef, "--", sub.path], root).match(
          /^160000 commit ([a-f0-9]+)\t/,
        );
        if (!entry?.[1]) throw new Error(`Missing historical submodule commit: ${sub.path}`);
        const childSnapshot = clone(actual, entry[1], `child-${snapshotIndex++}`);
        const localConfig = {
          ...releaseConfig,
          type: "default" as const,
          project: settings?.project,
          create_tag: settings?.create_tag ?? config.create_tag,
        };
        const project = resolveProjects(localConfig, childSnapshot)[0];
        const current = project && readProjectVersion(project);
        if (!current?.includes("-rc.")) continue;
        if (republish && !localConfig.create_tag) continue;
        const target = republish ? current : current.replace(/-rc\.\d+$/, "");
        prepare(actual, childSnapshot, entry[1], localConfig, target);
        selection.repos.push(sub.name);
        perRepoTags[sub.name] = { rcTag: null, finalTag: target };
      }
    }
    return {
      config: releaseConfig,
      selection,
      plan: {
        selectedEnvs: ["production"],
        rcTag: null,
        finalTag,
        mergePairedEnv: false,
        perRepoTags,
        preparedVersions,
        promotionSources: republish ? undefined : sources,
        republishSources: republish ? sources : undefined,
      },
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
