import * as fs from "node:fs";
import * as path from "node:path";
import type { SubprojectSelection, XEployConfig } from "./config.js";
import type { ReleasePlan } from "./flows.js";
import { currentBranch, getDirtyPaths, run } from "./git.js";
import { projectPath } from "./project-model.js";

interface Journal {
  schema: 1;
  root: string;
  config: XEployConfig;
  selection?: SubprojectSelection;
  plan: ReleasePlan;
  repositories: Record<string, { branch: string; head: string }>;
  steps: Record<string, "running" | "complete">;
}

function journalPath(root: string): string {
  return path.resolve(root, run("git", ["rev-parse", "--git-path", "xeploy-release.json"], root));
}
function save(journal: Journal): void {
  const file = journalPath(journal.root);
  fs.writeFileSync(
    `${file}.tmp`,
    `${JSON.stringify(journal, (key, value) => (key === "snapshot" ? undefined : value), 2)}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(`${file}.tmp`, file);
}
export function readReleaseJournal(root: string): Journal {
  const file = journalPath(root);
  if (!fs.existsSync(file)) throw new Error("No pending release to resume");
  const journal = JSON.parse(fs.readFileSync(file, "utf8")) as Journal;
  if (journal.schema !== 1 || path.resolve(journal.root) !== path.resolve(root))
    throw new Error("Invalid release recovery journal");
  return journal;
}
export function beginReleaseJournal(
  plan: ReleasePlan,
  config: XEployConfig,
  inputRoot: string,
  selection?: SubprojectSelection,
): void {
  const root = path.resolve(inputRoot);
  if (fs.existsSync(journalPath(root)))
    throw new Error("A release is pending; run xeploy --resume before starting another release");
  plan.journalRoot = root;
  const repositories: Journal["repositories"] = {};
  for (const cwd of Object.keys(plan.preparedVersions ?? {}))
    repositories[cwd] = {
      branch: currentBranch(cwd),
      head: run("git", ["rev-parse", "HEAD"], cwd),
    };
  repositories[root] ??= {
    branch: currentBranch(root),
    head: run("git", ["rev-parse", "HEAD"], root),
  };
  save({ schema: 1, root, config, selection, plan, repositories, steps: {} });
}
export async function releaseStep(
  root: string | undefined,
  cwd: string,
  key: string,
  action: () => void | Promise<void>,
): Promise<void> {
  if (!root) {
    await action();
    return;
  }
  const journal = readReleaseJournal(root);
  const id = `${path.resolve(cwd)}:${key}`;
  if (journal.steps[id] === "complete") return;
  journal.steps[id] = "running";
  save(journal);
  try {
    await action();
    journal.steps[id] = "complete";
  } catch (error) {
    throw new Error(`Release step ${key} failed in ${cwd}; run xeploy --resume to continue`, {
      cause: error,
    });
  } finally {
    const repo = journal.repositories[path.resolve(cwd)];
    if (repo) {
      repo.head = run("git", ["rev-parse", "HEAD"], cwd);
      repo.branch = currentBranch(cwd);
    }
    save(journal);
  }
}
export function verifyReleaseResume(root: string): Journal {
  const journal = readReleaseJournal(root);
  for (const [cwd, repo] of Object.entries(journal.repositories)) {
    // Only the original graph may be resumed; user commits require a new plan.
    if (currentBranch(cwd) !== repo.branch || run("git", ["rev-parse", "HEAD"], cwd) !== repo.head)
      throw new Error(
        `Release branch changed in ${cwd}; restore ${repo.branch} at ${repo.head} before resuming`,
      );
    const dirty = getDirtyPaths(cwd);
    const childPaths = Object.keys(journal.repositories)
      .filter((child) => child !== cwd)
      .map((child) => path.relative(cwd, child));
    const pendingEdits = Object.values(journal.plan.preparedVersions?.[cwd] ?? {}).flatMap(
      (tier) => tier.edits,
    );
    for (const file of dirty) {
      if (childPaths.includes(file)) continue;
      const edit = pendingEdits.find(
        (edit) =>
          edit.path === file &&
          fs.existsSync(projectPath(cwd, file)) &&
          fs.readFileSync(projectPath(cwd, file), "utf8") === edit.after,
      );
      if (!edit) throw new Error(`Unexpected local change blocks release recovery: ${file}`);
    }
  }
  return journal;
}
export function completeReleaseJournal(root: string | undefined): void {
  if (root) fs.unlinkSync(journalPath(root));
}
