import * as p from "@clack/prompts";
import { ensureConfig, runConfigEditor } from "./config-editor.js";
import {
  flowNewRelease,
  flowOldRelease,
  promptSubprojectSelection,
  verifySelectedRepoAccess,
} from "./flows.js";
import { ensurePrereqs, getLatestTag, getTags } from "./git.js";
import { isBack } from "./prompts-util.js";
import { formatSemVer } from "./semver.js";
import { VERSION } from "./version.js";

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

const cwd = process.cwd();

p.intro(`
__  _______ ____  _     _____   __
\\ \\/ / ____|  _ \\| |   / _ \\ \\ / /
 \\  /|  _| | |_) | |  | | | \\ V / 
 /  \\| |___|  __/| |__| |_| || |  
/_/\\_\\_____|_|   |_____\\___/ |_|  
`);

p.intro(`🚀 xeploy ${VERSION}`);

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

  const selection = await promptSubprojectSelection(config);
  if (isBack(selection)) {
    continue;
  }

  if (!verifySelectedRepoAccess(config, cwd, selection)) {
    continue;
  }

  const result = await flowNewRelease(tags, config, cwd, selection);
  if (isBack(result)) {
    continue;
  }
  p.outro("Done ✔");
  process.exit(0);
}
