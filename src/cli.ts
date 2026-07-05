import * as p from "@clack/prompts";
import { ensureConfig, runConfigEditor } from "./config-editor.js";
import { flowNewRelease, flowOldRelease } from "./flows.js";
import { ensurePrereqs, getLatestTag, getTags } from "./git.js";
import { formatSemVer } from "./semver.js";

const cwd = process.cwd();

p.intro("🚀  x-bump");

ensurePrereqs(cwd);

const config = await ensureConfig(cwd);

const tags = getTags(cwd);
const latest = getLatestTag(tags);

if (latest) {
  p.log.info(`Latest release: ${formatSemVer(latest)}`);
} else {
  p.log.warn("No releases yet — empty-repo mode.");
}

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
  await runConfigEditor(config, cwd);
  p.outro("Done ✔");
  process.exit(0);
}

if (topChoice === "old") {
  await flowOldRelease(tags, config, cwd);
  p.outro("Done ✔");
  process.exit(0);
}

await flowNewRelease(tags, config, cwd);

p.outro("Done ✔");
