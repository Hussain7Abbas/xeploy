import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_FILE } from "./config.js";
import {
  currentBranch,
  getDirtyPaths,
  gitAdd,
  gitCommit,
  hasChangesToCommit,
  pushBranch,
} from "./git.js";
import { parseSemVer } from "./semver.js";
import type { SemVer } from "./semver.js";
import { assertRepoRelativePath, assertSemverTag } from "./validate.js";

export function readPackageVersion(filePath: string): SemVer | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      version?: unknown;
    };
    if (typeof parsed.version !== "string") {
      return null;
    }
    return parseSemVer(parsed.version);
  } catch {
    return null;
  }
}

export function setVersionInFile(filePath: string, version: string): boolean {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.version === version) {
    return false;
  }
  parsed.version = version;
  const indent = raw.match(/^{\n(\s+)/)?.[1]?.length ?? 2;
  fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, indent)}\n`);
  return true;
}

export function bumpVersionFiles(
  version: string,
  filePaths: string[],
  cwd: string,
  opts?: {
    includeConfigIfDirty?: boolean;
    /** Per-file version overrides keyed by repo-relative path. */
    fileVersions?: Record<string, string>;
  },
): void {
  const safeVersion = assertSemverTag(version);
  const changedPaths: string[] = [];

  for (const f of filePaths) {
    const rel = path.isAbsolute(f) ? path.relative(cwd, f) : f;
    assertRepoRelativePath(cwd, rel);
    const abs = path.join(cwd, rel);
    if (!fs.existsSync(abs)) {
      console.warn(`[xeploy] Version file not found, skipping: ${abs}`);
      continue;
    }
    const override = opts?.fileVersions?.[rel];
    const targetVersion = override ? assertSemverTag(override) : safeVersion;
    if (setVersionInFile(abs, targetVersion)) {
      changedPaths.push(rel);
    }
  }

  const pathsToStage = [...changedPaths];
  if (opts?.includeConfigIfDirty) {
    const dirty = getDirtyPaths(cwd);
    if (dirty.includes(CONFIG_FILE) && !pathsToStage.includes(CONFIG_FILE)) {
      pathsToStage.push(CONFIG_FILE);
    }
  }

  if (pathsToStage.length === 0) {
    return;
  }

  gitAdd(pathsToStage, cwd);
  if (hasChangesToCommit(cwd)) {
    gitCommit(`chore(release): bump to ${safeVersion}`, cwd);
    pushBranch(currentBranch(cwd), cwd);
  }
}
