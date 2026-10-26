import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectDescriptor } from "./project-model.js";
import { ProjectSourceError, projectPath } from "./project-model.js";
import { assertReleaseVersion } from "./validate.js";

export function goModuleTag(project: ProjectDescriptor, version: string): string {
  assertReleaseVersion(version);
  const raw = fs.readFileSync(
    projectPath(project.root, path.join(project.directory, "go.mod")),
    "utf8",
  );
  const module = raw.match(/^\s*module\s+(?:"([^"\r\n]+)"|([^\s]+))\s*(?:\/\/[^\r\n]*)?$/m);
  const modulePath = module?.[1] ?? module?.[2];
  if (!modulePath)
    throw new ProjectSourceError(`Missing Go module declaration in ${project.directory}`);
  const targetMajor = Number(version.split(".")[0]);
  const pathMajor = Number(modulePath.match(/(?:\/v|\.v)(\d+)$/)?.[1] ?? "1");
  if ((targetMajor >= 2 && targetMajor !== pathMajor) || (targetMajor < 2 && pathMajor >= 2)) {
    throw new ProjectSourceError(
      `Go import-path migration required for ${modulePath} to release ${version}; update the module path and imports manually before retrying`,
    );
  }
  let directory = project.directory === "." ? "" : project.directory.replaceAll(path.sep, "/");
  if (pathMajor >= 2 && directory.endsWith(`/v${pathMajor}`))
    directory = directory.slice(0, -`/v${pathMajor}`.length);
  else if (directory === `v${pathMajor}` && pathMajor >= 2) directory = "";
  return `${directory ? `${directory}/` : ""}v${version}`;
}
