import * as fs from "node:fs";
import * as path from "node:path";
import { gitAdd, gitCommit, hasChangesToCommit } from "./git.js";
import { assertRepoRelativePath, assertSemverTag } from "./validate.js";

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
    if (setVersionInFile(abs, safeVersion)) {
      changedPaths.push(rel);
    }
  }

  if (changedPaths.length === 0) {
    return;
  }

  gitAdd(changedPaths, cwd);
  if (hasChangesToCommit(cwd)) {
    gitCommit(`chore(release): bump to ${safeVersion}`, cwd);
  }
}
