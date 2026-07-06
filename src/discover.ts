import * as fs from "node:fs";
import * as path from "node:path";
import { assertRepoRelativePath } from "./validate.js";

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
