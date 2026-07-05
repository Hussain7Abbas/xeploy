import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as p from "@clack/prompts";
import { compareSemVer, parseSemVer } from "./semver.js";
import type { SemVer } from "./semver.js";

export interface SubmoduleInfo {
  name: string;
  path: string;
}

export function run(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    stdio: "pipe",
    encoding: "utf8",
    cwd,
  }).trim();
}

export function runInherit(cmd: string, cwd?: string): void {
  execSync(cmd, { stdio: "inherit", cwd });
}

export function tryRun(cmd: string, cwd?: string): string | null {
  try {
    return run(cmd, cwd);
  } catch {
    return null;
  }
}

export function ensurePrereqs(cwd: string = process.cwd()): void {
  const ghAuth = tryRun("gh auth status 2>&1", cwd);
  if (!ghAuth || ghAuth.includes("not logged in")) {
    p.cancel("gh CLI is not authenticated. Run: gh auth login");
    process.exit(1);
  }
  if (!tryRun("git rev-parse --git-dir", cwd)) {
    p.cancel("Not inside a git repository.");
    process.exit(1);
  }
  if (!tryRun("git remote get-url origin", cwd)) {
    p.cancel('No "origin" remote configured.');
    process.exit(1);
  }
  const s = p.spinner();
  s.start("Fetching tags and branches from origin");
  try {
    runInherit("git fetch --tags --prune origin", cwd);
    s.stop("Fetched tags and branches");
  } catch {
    s.stop("Fetch failed — continuing with local state");
  }
}

export function requireCleanTree(cwd: string = process.cwd()): void {
  if (run("git status --porcelain", cwd)) {
    p.cancel("Working tree has uncommitted changes. Please commit or stash first.");
    process.exit(1);
  }
}

export function currentBranch(cwd: string = process.cwd()): string {
  return run("git rev-parse --abbrev-ref HEAD", cwd);
}

export function listBranches(cwd: string = process.cwd()): string[] {
  const branches = new Set<string>();

  const local = tryRun('git branch --format="%(refname:short)"', cwd);
  if (local) {
    for (const b of local.split("\n")) {
      const trimmed = b.trim().replace(/^"|"$/g, "");
      if (trimmed) {
        branches.add(trimmed);
      }
    }
  }

  const remote = tryRun('git branch -r --format="%(refname:short)"', cwd);
  if (remote) {
    for (const b of remote.split("\n")) {
      const trimmed = b.trim().replace(/^"|"$/g, "");
      if (!trimmed || trimmed.includes("HEAD")) {
        continue;
      }
      const name = trimmed.replace(/^origin\//, "");
      if (name) {
        branches.add(name);
      }
    }
  }

  return [...branches].sort((a, b) => a.localeCompare(b));
}

export function listSubmodules(cwd: string = process.cwd()): SubmoduleInfo[] {
  const gitmodules = path.join(cwd, ".gitmodules");
  if (!fs.existsSync(gitmodules)) {
    return [];
  }

  const content = fs.readFileSync(gitmodules, "utf8");
  const submodules: SubmoduleInfo[] = [];
  const sections = content.split(/\[submodule /).slice(1);

  for (const section of sections) {
    const nameMatch = section.match(/^"([^"]+)"/);
    const pathMatch = section.match(/^\s*path\s*=\s*(.+)$/m);
    if (nameMatch?.[1] && pathMatch?.[1]) {
      submodules.push({
        name: nameMatch[1],
        path: pathMatch[1].trim(),
      });
    }
  }

  return submodules;
}

export function getTags(cwd: string = process.cwd()): SemVer[] {
  const raw = tryRun("git tag --list", cwd);
  if (!raw) {
    return [];
  }
  return raw
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean)
    .map(parseSemVer)
    .filter((v): v is SemVer => v !== null);
}

export function getLatestTag(tags: SemVer[]): SemVer | null {
  if (tags.length === 0) {
    return null;
  }
  return tags.reduce((best, v) => (compareSemVer(v, best) > 0 ? v : best));
}

export function getLatestRcTag(tags: SemVer[]): SemVer | null {
  const rcs = tags.filter((v) => v.rc !== null);
  if (rcs.length === 0) {
    return null;
  }
  return rcs.reduce((best, v) => (compareSemVer(v, best) > 0 ? v : best));
}

export function getLatestFinalTag(tags: SemVer[]): SemVer | null {
  const finals = tags.filter((v) => v.rc === null);
  if (finals.length === 0) {
    return null;
  }
  return finals.reduce((best, v) => (compareSemVer(v, best) > 0 ? v : best));
}

export function getRcTags(tags: SemVer[]): SemVer[] {
  return tags.filter((v) => v.rc !== null).sort((a, b) => compareSemVer(b, a));
}

export function tagExists(tag: string, cwd: string = process.cwd()): boolean {
  return tryRun(`git rev-parse --verify "refs/tags/${tag}"`, cwd) !== null;
}

export function ghReleaseExists(tag: string, cwd: string = process.cwd()): boolean {
  const out = tryRun(`gh release view "${tag}" 2>&1`, cwd);
  return out !== null && !out.includes("release not found");
}

export function createRelease(opts: {
  tag: string;
  prerelease: boolean;
  notesStartTag: string | null;
  branch: string;
  generateReleaseNotes: boolean;
  cwd?: string;
}): void {
  const cwd = opts.cwd ?? process.cwd();
  let cmd = `gh release create "${opts.tag}" --title "${opts.tag}" --target "${opts.branch}"`;
  if (opts.generateReleaseNotes) {
    cmd += " --generate-notes";
    if (opts.notesStartTag) {
      cmd += ` --notes-start-tag "${opts.notesStartTag}"`;
    }
  } else {
    cmd += ' --notes ""';
  }
  if (opts.prerelease) {
    cmd += " --prerelease";
  }
  runInherit(cmd, cwd);
}

export function republishRc(
  tag: string,
  opts?: { generateReleaseNotes?: boolean; cwd?: string },
): void {
  const cwd = opts?.cwd ?? process.cwd();
  const generateReleaseNotes = opts?.generateReleaseNotes ?? true;
  if (ghReleaseExists(tag, cwd)) {
    runInherit(`gh release delete "${tag}" --yes`, cwd);
  }
  tryRun(`git push origin "${tag}"`, cwd);
  createRelease({
    tag,
    prerelease: true,
    notesStartTag: null,
    branch: currentBranch(cwd),
    generateReleaseNotes,
    cwd,
  });
}

export function createReleaseBranch(
  branchName: string,
  fromBranch: string,
  cwd: string = process.cwd(),
): void {
  runInherit(`git branch "${branchName}" "${fromBranch}"`, cwd);
  runInherit(`git push -u origin "${branchName}"`, cwd);
}

export function openPr(opts: {
  head: string;
  base: string;
  title: string;
  body?: string;
  cwd?: string;
}): void {
  const cwd = opts.cwd ?? process.cwd();
  const bodyArg = opts.body ? ` --body "${opts.body.replace(/"/g, '\\"')}"` : ' --body ""';
  runInherit(
    `gh pr create --base "${opts.base}" --head "${opts.head}" --title "${opts.title}"${bodyArg}`,
    cwd,
  );
}

export async function syncBranch(
  target: string,
  newTag: string,
  originalBranch: string,
  cwd: string = process.cwd(),
): Promise<void> {
  const remote = tryRun(`git ls-remote --heads origin ${target}`, cwd);
  if (!remote) {
    p.note(`Branch "${target}" does not exist on origin — skipping sync.`, "Skipped");
    return;
  }

  const doSync = await p.confirm({
    message: `Merge "${originalBranch}" into "${target}" and push?`,
    initialValue: true,
  });
  if (p.isCancel(doSync) || !doSync) {
    p.log.info("Branch sync skipped.");
    return;
  }

  const s = p.spinner();
  try {
    s.start(`Syncing branch "${target}"`);
    runInherit(`git checkout "${target}"`, cwd);
    runInherit("git pull --ff-only", cwd);
    runInherit(`git merge "${originalBranch}" --no-edit`, cwd);
    runInherit(`git push origin "${target}"`, cwd);
    runInherit(`git push origin "${newTag}"`, cwd);
    s.stop(`Branch "${target}" synced`);
  } catch {
    s.stop("Sync failed");
    tryRun("git merge --abort", cwd);
    p.log.error("Merge conflict or push failure — merge aborted. Please resolve manually.");
  } finally {
    runInherit(`git checkout "${originalBranch}"`, cwd);
    runInherit(`git push origin "${originalBranch}"`, cwd);
  }
}

export async function mergeOrPr(opts: {
  envBranch: string;
  sourceBranch: string;
  tag: string;
  createPr: boolean;
  prTitle: string;
  cwd?: string;
}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const remote = tryRun(`git ls-remote --heads origin ${opts.envBranch}`, cwd);
  if (!remote) {
    p.note(`Branch "${opts.envBranch}" does not exist on origin — skipping.`, "Skipped");
    return;
  }

  if (opts.createPr) {
    const s = p.spinner();
    s.start(`Opening PR: ${opts.sourceBranch} → ${opts.envBranch}`);
    try {
      openPr({
        head: opts.sourceBranch,
        base: opts.envBranch,
        title: opts.prTitle,
        cwd,
      });
      s.stop(`PR opened: ${opts.sourceBranch} → ${opts.envBranch}`);
    } catch {
      s.stop("Failed to open PR");
      p.log.error("Could not create pull request. Please open it manually.");
    }
    return;
  }

  await syncBranch(opts.envBranch, opts.tag, opts.sourceBranch, cwd);
}

export function commitSubmodulePointers(
  submodulePaths: string[],
  message: string,
  cwd: string = process.cwd(),
): void {
  const paths = submodulePaths.map((p) => `"${p}"`).join(" ");
  runInherit(`git add ${paths}`, cwd);
  runInherit(`git commit -m "${message}"`, cwd);
}

export function initSubmodules(cwd: string = process.cwd()): void {
  tryRun("git submodule update --init --recursive", cwd);
}
