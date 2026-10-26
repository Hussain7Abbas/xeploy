import * as fs from "node:fs";
import { replaceSpans } from "./project-edits.js";
import type { FileEdit, ProjectDescriptor } from "./project-model.js";
import { ProjectSourceError, projectPath } from "./project-model.js";
import { assertReleaseVersion } from "./validate.js";

export const RELEASE_STATE_FILE = ".xeploy-state.json";

export interface ProjectReleaseState {
  version: string;
  source: string;
  nativeVersion: string;
  counters?: Record<string, string>;
}

interface ReleaseState {
  schema: 1;
  projects: Record<string, ProjectReleaseState>;
}

export function readReleaseState(
  root: string,
  snapshot?: ReadonlyMap<string, string | null>,
): ReleaseState {
  const file = projectPath(root, RELEASE_STATE_FILE);
  const raw = snapshot?.has(RELEASE_STATE_FILE)
    ? snapshot.get(RELEASE_STATE_FILE)
    : fs.existsSync(file)
      ? fs.readFileSync(file, "utf8")
      : null;
  if (raw === null || raw === undefined) return { schema: 1, projects: {} };
  const state = JSON.parse(raw) as ReleaseState;
  if (
    state.schema !== 1 ||
    !state.projects ||
    typeof state.projects !== "object" ||
    Array.isArray(state.projects)
  ) {
    throw new ProjectSourceError(`Invalid ${RELEASE_STATE_FILE}`);
  }
  for (const value of Object.values(state.projects)) {
    if (!value || typeof value.source !== "string" || typeof value.nativeVersion !== "string")
      throw new ProjectSourceError(`Invalid ${RELEASE_STATE_FILE}`);
    assertReleaseVersion(value.version);
  }
  return state;
}

export function releaseStateEdit(
  project: ProjectDescriptor,
  record: ProjectReleaseState,
): FileEdit | undefined {
  const state = readReleaseState(project.root, project.snapshot);
  const file = projectPath(project.root, RELEASE_STATE_FILE);
  const before = project.snapshot?.has(RELEASE_STATE_FILE)
    ? (project.snapshot.get(RELEASE_STATE_FILE) ?? null)
    : fs.existsSync(file)
      ? fs.readFileSync(file, "utf8")
      : null;
  state.projects[project.id] = record;
  const after = `${JSON.stringify(state, null, 2)}\n`;
  return before === after ? undefined : { path: RELEASE_STATE_FILE, before, after };
}

/** State records for different projects share one repository-level file. */
export function mergeProjectEdits(edits: FileEdit[]): FileEdit[] {
  const merged = new Map<string, FileEdit>();
  for (const edit of edits) {
    const old = merged.get(edit.path);
    if (!old) {
      merged.set(edit.path, edit);
      continue;
    }
    if (old.before !== edit.before) throw new ProjectSourceError(`Stale source: ${edit.path}`);
    if (edit.path === RELEASE_STATE_FILE) {
      const previous = JSON.parse(old.after) as ReleaseState;
      const next = JSON.parse(edit.after) as ReleaseState;
      const initial = edit.before ? (JSON.parse(edit.before) as ReleaseState).projects : {};
      for (const [key, value] of Object.entries(next.projects)) {
        if (JSON.stringify(value) !== JSON.stringify(initial[key])) {
          if (
            JSON.stringify(previous.projects[key]) !== JSON.stringify(initial[key]) &&
            JSON.stringify(previous.projects[key]) !== JSON.stringify(value)
          )
            throw new ProjectSourceError(`Conflicting canonical release identities for ${key}`);
          previous.projects[key] = value;
        }
      }
      old.after = `${JSON.stringify(previous, null, 2)}\n`;
    } else if (old.after !== edit.after) {
      if (!old.changes || !edit.changes || old.before === null)
        throw new ProjectSourceError(`Conflicting version edits for ${edit.path}`);
      const changes = [...old.changes];
      for (const change of edit.changes) {
        const duplicate = changes.find(
          (existing) =>
            existing.start === change.start &&
            existing.end === change.end &&
            existing.replacement === change.replacement,
        );
        if (!duplicate) changes.push(change);
      }
      try {
        old.after = replaceSpans(
          old.before,
          changes.map((change) => ({ span: change, value: change.replacement })),
        );
      } catch {
        throw new ProjectSourceError(`Conflicting version edits for ${edit.path}`);
      }
      old.changes = changes;
    }
  }
  return [...merged.values()];
}
