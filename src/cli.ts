import * as p from "@clack/prompts";
import { ensureConfig, runConfigEditor } from "./config-editor.js";
import { flowNewRelease, flowOldRelease } from "./flows.js";
import { ensurePrereqs, getLatestTag, getTags } from "./git.js";
import { isBack } from "./prompts-util.js";
import { formatSemVer } from "./semver.js";

const cwd = process.cwd();

p.intro("🚀  xeploy");

ensurePrereqs(cwd);

const config = await ensureConfig(cwd);

const tags = getTags(cwd);
const latest = getLatestTag(tags);

if (latest) {
  p.log.info(`Latest release: ${formatSemVer(latest)}`);
} else {
  p.log.warn("No releases yet — empty-repo mode.");
}

while (true) {
  const topChoice = await p.select<"new" | "old" | "config">({
    message: "What would you like to do?",
    options: [
      { label: "Deploy new release", value: "new" },
      { label: "Deploy old release", value: "old" },
      { label: "Config", value: "config" },
    ],
  });

  if (p.isCancel(topChoice)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }

  if (topChoice === "config") {
    const result = await runConfigEditor(config, cwd);
    if (isBack(result)) {
      continue;
    }
    p.outro("Done ✔");
    process.exit(0);
  }

  if (topChoice === "old") {
    const result = await flowOldRelease(tags, config, cwd);
    if (isBack(result)) {
      continue;
    }
    p.outro("Done ✔");
    process.exit(0);
  }

  const result = await flowNewRelease(tags, config, cwd);
  if (isBack(result)) {
    continue;
  }
  p.outro("Done ✔");
  process.exit(0);
}
