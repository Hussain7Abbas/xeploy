import * as p from "@clack/prompts";
import { CLI_HELP, parseCliOptions } from "./cli-options.js";
import { ensureConfig, runConfigEditor } from "./config-editor.js";
import {
  flowNewRelease,
  flowOldRelease,
  promptSubprojectSelection,
  verifySelectedRepoAccess,
} from "./flows.js";
import { ensurePrereqs, getLatestTag, startBackgroundTagFetch } from "./git.js";
import { isBack } from "./prompts-util.js";
import { formatSemVer } from "./semver.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(CLI_HELP);
    return;
  }
  if (options.showVersion) {
    console.log(VERSION);
    return;
  }

  const directRelease = Boolean(
    options.version || options.bump || options.environments || options.unify,
  );
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
  const tagFetch = startBackgroundTagFetch(cwd);

  const latest = getLatestTag(tagFetch.getLocalTags());

  if (latest) {
    p.log.info(`Latest release: ${formatSemVer(latest)}`);
  } else {
    p.log.warn("No releases yet — empty-repo mode.");
  }

  while (true) {
    const topChoice = directRelease
      ? "new"
      : await p.select<"new" | "old" | "config">({
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
      const result = await flowOldRelease(tagFetch, config, cwd);
      if (isBack(result)) {
        continue;
      }
      p.outro("Done ✔");
      process.exit(0);
    }

    const selection = await promptSubprojectSelection(config);
    if (isBack(selection)) {
      if (directRelease) return;
      continue;
    }

    if (!verifySelectedRepoAccess(config, cwd, selection)) {
      if (directRelease) process.exit(1);
      continue;
    }

    const result = await flowNewRelease(tagFetch, config, cwd, selection, options);
    if (isBack(result)) {
      if (directRelease) return;
      continue;
    }
    p.outro("Done ✔");
    process.exit(0);
  }
}

main().catch((error: unknown) => {
  p.cancel(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
