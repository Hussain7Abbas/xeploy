import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectCandidate } from "./project-model.js";
import { assertRepoRelativePath } from "./validate.js";

const IGNORED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "target",
  "vendor",
  "venv",
  "__pycache__",
  "bin",
  "obj",
  "Library",
  "Temp",
  "Logs",
  "Builds",
  "Intermediate",
  "Binaries",
  "DerivedDataCache",
  "Saved",
  "Pods",
  "Carthage",
]);

export function shouldSkipProjectDirectory(name: string): boolean {
  return name.startsWith(".") || IGNORED_DIRECTORIES.has(name);
}

/** Recognize project identity without parsing versions or writing any files. */
export function projectCandidates(directory: string): ProjectCandidate[] {
  if (!fs.existsSync(directory)) return [];
  const names = fs.readdirSync(directory);
  const has = (name: string) =>
    names.includes(name) && fs.statSync(path.join(directory, name)).isFile();
  if (fs.existsSync(path.join(directory, "ProjectSettings/ProjectSettings.asset"))) {
    return [{ ecosystem: "unity", file: "ProjectSettings/ProjectSettings.asset" }];
  }
  if (has("project.godot")) return [{ ecosystem: "godot", file: "project.godot" }];
  if (names.some((name) => name.endsWith(".uproject"))) {
    return [{ ecosystem: "unreal", file: "Config/DefaultGame.ini" }];
  }
  const candidates: ProjectCandidate[] = [];
  const add = (file: string, ecosystem: ProjectCandidate["ecosystem"]) => {
    if (has(file)) candidates.push({ ecosystem, file });
  };
  add("pubspec.yaml", "flutter");
  add("package.json", "javascript");
  add("pyproject.toml", "python");
  if (!has("pyproject.toml")) {
    add("setup.cfg", "python");
    if (!has("setup.cfg")) add("setup.py", "python");
  }
  add("Cargo.toml", "rust");
  add("go.mod", "go");
  add("pom.xml", "java");
  if (!has("pom.xml")) {
    add("build.gradle", "java");
    add("build.gradle.kts", "java");
    if (!has("build.gradle") && !has("build.gradle.kts")) add("gradle.properties", "java");
  }
  const dotnetProjects = names.filter((name) => /\.(cs|fs|vb)proj$/.test(name));
  for (const name of dotnetProjects) add(name, "dotnet");
  if (!dotnetProjects.length) add("Directory.Build.props", "dotnet");
  add("plugin.cfg", "godot");
  for (const name of names) if (name.endsWith(".uplugin")) add(name, "unreal");
  if (candidates.length === 0) add("VERSION", "generic");
  return candidates;
}

export function discoverProjectDirectories(root: string): string[] {
  const projects: string[] = [];
  const walk = (directory: string) => {
    const candidates = projectCandidates(directory);
    if (candidates.length) projects.push(path.relative(root, directory) || ".");
    // Engine internals contain generated projects and dependencies, not independent apps.
    if (candidates.some((p) => ["unity", "godot", "unreal", "flutter"].includes(p.ecosystem))) {
      // A game/mobile umbrella may still own unrelated apps in conventional containers.
      for (const container of ["apps", "services", "packages"]) {
        const nested = path.join(directory, container);
        if (fs.existsSync(nested) && fs.lstatSync(nested).isDirectory()) walk(nested);
      }
      return;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !shouldSkipProjectDirectory(entry.name))
        walk(path.join(directory, entry.name));
    }
  };
  walk(root);
  return projects.sort();
}

export interface SubmoduleInfo {
  name: string;
  path: string;
}

export function parseSubmodules(cwd: string): SubmoduleInfo[] {
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
      const subPath = pathMatch[1].trim();
      assertRepoRelativePath(cwd, subPath);
      submodules.push({
        name: nameMatch[1],
        path: subPath,
      });
    }
  }

  return submodules;
}
