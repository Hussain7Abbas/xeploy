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
import { applyFileEdits } from "./project-edits.js";
import type { FileEdit, ProjectDescriptor } from "./project-model.js";
import { projectPath } from "./project-model.js";
import { mergeProjectEdits } from "./project-state.js";
import { prepareProjectVersion } from "./projects.js";
import { parseSemVer } from "./semver.js";
import type { SemVer } from "./semver.js";
import { assertSemverTag } from "./validate.js";

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
  const edit = prepareLegacyVersionFile(filePath, version);
  if (!edit) return false;
  fs.writeFileSync(filePath, edit.after);
  return true;
}

function prepareLegacyVersionFile(filePath: string, version: string): FileEdit | undefined {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed.version === version) {
    return undefined;
  }
  parsed.version = version;
  const indent = raw.match(/^{\n(\s+)/)?.[1]?.length ?? 2;
  return { path: filePath, before: raw, after: `${JSON.stringify(parsed, null, indent)}\n` };
}

export function bumpVersionFiles(
  version: string,
  filePaths: string[],
  cwd: string,
  opts?: {
    includeConfigIfDirty?: boolean;
    /** Per-file version overrides keyed by repo-relative path. */
    fileVersions?: Record<string, string>;
    projects?: ProjectDescriptor[];
    edits?: FileEdit[];
    push?: boolean;
    allowApplied?: boolean;
  },
): void {
  const safeVersion = assertSemverTag(version);
  const edits =
    opts?.edits ??
    opts?.projects?.flatMap((project) => {
      const rel = path.join(project.directory, project.versionFile);
      return prepareProjectVersion(project, opts.fileVersions?.[rel] ?? safeVersion);
    }) ??
    filePaths.flatMap((file) => {
      const relative = path.isAbsolute(file) ? path.relative(cwd, file) : file;
      const absolute = projectPath(cwd, relative);
      if (!fs.existsSync(absolute)) throw new Error(`Version file not found: ${absolute}`);
      const target = opts?.fileVersions?.[relative] ?? safeVersion;
      const edit = prepareLegacyVersionFile(absolute, assertSemverTag(target));
      return edit ? [{ ...edit, path: relative }] : [];
    });
  const changedPaths = applyFileEdits(cwd, mergeProjectEdits(edits), opts?.allowApplied);

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
    if (opts?.push !== false) pushBranch(currentBranch(cwd), cwd);
  }
}
