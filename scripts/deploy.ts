import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as p from "@clack/prompts";

const result = spawnSync("node", ["dist/cli.js"], { stdio: "inherit" });

if (result.status !== 0) process.exit(result.status ?? 1);

execSync("git fetch --tags --prune origin", { stdio: "inherit" });

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as {
  version: string;
};
const version = pkg.version;
const isStaging = version.includes("-rc.");

const publish = await p.confirm({
  message: `Publish ${isStaging ? `beta (${version})` : `production (${version})`} to npm?`,
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
