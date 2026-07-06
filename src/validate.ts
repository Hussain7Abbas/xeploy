import * as path from "node:path";

const BRANCH_NAME_RE = /^[A-Za-z0-9._/-]+$/;
const SEMVER_TAG_RE = /^\d+\.\d+\.\d+(-rc\.\d+)?$/;

export function assertBranchName(name: string): string {
  if (!name || !BRANCH_NAME_RE.test(name) || name.includes("..")) {
    throw new Error(`Invalid branch name: ${name}`);
  }
  return name;
}

export function assertSemverTag(tag: string): string {
  if (!SEMVER_TAG_RE.test(tag)) {
    throw new Error(`Invalid semver tag: ${tag}`);
  }
  return tag;
}

export function assertRepoRelativePath(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath);
  const normalizedRoot = path.resolve(root);
  const rootWithSep = `${normalizedRoot}${path.sep}`;
  if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Path escapes repo root: ${relativePath}`);
  }
  return resolved;
}

export function assertCommitMessage(msg: string): string {
  if (msg.includes('"') || msg.includes("\n") || msg.includes("\r")) {
    throw new Error("Invalid commit message");
  }
  return msg;
}

export function isValidBranchName(name: string): boolean {
  try {
    assertBranchName(name);
    return true;
  } catch {
    return false;
  }
}

export function resolveSubmodulePath(repoRoot: string, submodulePath: string): string {
  assertRepoRelativePath(repoRoot, submodulePath);
  return path.resolve(repoRoot, submodulePath);
}
