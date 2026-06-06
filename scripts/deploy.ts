import { execSync, spawnSync } from "child_process";
import * as p from "@clack/prompts";

const result = spawnSync("node", ["dist/cli.js"], { stdio: "inherit" });

if (result.status !== 0) process.exit(result.status ?? 1);

const latestTag = execSync("git describe --tags --abbrev=0").toString().trim();
const isStaging = latestTag.includes("-rc.");

const publish = await p.confirm({
  message: `Publish ${isStaging ? `beta (${latestTag})` : `production (${latestTag})`} to npm?`,
  initialValue: false,
});

if (p.isCancel(publish) || !publish) {
  p.cancel("Publish skipped.");
  process.exit(0);
}

if (isStaging) {
  execSync("make publish-beta", { stdio: "inherit" });
} else {
  execSync("make publish-dry", { stdio: "inherit" });
  execSync("make publish", { stdio: "inherit" });
}
