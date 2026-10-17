import { afterEach, expect, mock, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCliOptions } from "../src/cli-options.js";
import type { XEployConfig } from "../src/config.js";
import { getTags } from "../src/git.js";
import { VERSION } from "../src/version.js";

const cancel = Symbol("cancel");
const selections: unknown[] = [];
const confirmations: string[] = [];
const summaries: string[] = [];
let cancelConfirmation = false;
mock.module("@clack/prompts", () => ({
  select: async () => {
    if (!selections.length) throw new Error("Unexpected selection prompt");
    return selections.shift();
  },
  confirm: async ({ message }: { message: string }) => {
    confirmations.push(message);
    return cancelConfirmation ? cancel : true;
  },
  isCancel: (value: unknown) => value === cancel,
  spinner: () => ({ start() {}, stop() {} }),
  note: (text: string) => summaries.push(text),
  log: { info() {}, warn() {}, error() {}, step() {}, success() {} },
}));
const { flowNewRelease, planRelease } = await import("../src/flows.js");
const { BACK } = await import("../src/prompts-util.js");

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  selections.length = 0;
  confirmations.length = 0;
  summaries.length = 0;
  cancelConfirmation = false;
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixture(version = "1.0.0") {
  const dir = mkdtempSync(join(tmpdir(), "xeploy-args-"));
  tempDirs.push(dir);
  const cwd = join(dir, "repo");
  const remote = join(dir, "origin.git");
  mkdirSync(cwd);
  git(dir, "init", "--bare", "--initial-branch=develop", remote);
  git(cwd, "init", "--initial-branch=develop");
  git(cwd, "config", "user.name", "Xeploy Test");
  git(cwd, "config", "user.email", "test@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "fixture", version }));
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "initial");
  git(cwd, "remote", "add", "origin", remote);
  git(cwd, "push", "-u", "origin", "develop");
  const config: XEployConfig = {
    type: "default",
    subprojectsDir: null,
    tag_prefix: "",
    generate_release_notes: false,
    create_production_release_branch: false,
    create_tag: false,
    create_pr: { staging: false, uat: false, sandbox: false, production: false },
    environments: {
      develop: "develop",
      staging: "staging",
      uat: "uat",
      sandbox: "sandbox",
      production: "main",
    },
  };
  for (const branch of ["staging", "uat", "sandbox", "main"]) {
    git(cwd, "branch", branch);
    git(cwd, "push", "-u", "origin", branch);
  }
  const fetch = {
    ready: Promise.resolve(),
    isSettled: () => true,
    getLocalTags: () => getTags(cwd),
  };
  return { cwd, remote, config, fetch, dir };
}

test("parses release arguments, equals syntax, booleans, and standalone version/help", () => {
  expect(parseCliOptions([])).toEqual({ showVersion: false, help: false });
  expect(parseCliOptions(["--version"])).toMatchObject({ showVersion: true });
  expect(parseCliOptions(["--help"])).toMatchObject({ help: true });
  expect(parseCliOptions(["--version", "1.0.1-rc.6", "--uat", "1", "--staging=0"])).toMatchObject({
    version: "1.0.1-rc.6",
    environments: ["uat"],
    showVersion: false,
  });
  expect(
    parseCliOptions(["--bump=minor", "--production=true", "--sandbox", "false"]),
  ).toMatchObject({ bump: "minor", environments: ["production"] });
  expect(parseCliOptions(["--uat", "1", "--staging", "1"]).environments).toEqual([
    "staging",
    "uat",
  ]);
});

test("rejects malformed, missing, conflicting, duplicate, and unknown arguments", () => {
  const invalid = [
    ["--version", "1.0"],
    ["--version", "v1.0.0"],
    ["--version", "01.0.0"],
    ["--version", "1.0.0-beta.1"],
    ["--version", "1.0.0-rc.01"],
    ["--version="],
    ["--version", "9007199254740992.0.0"],
    ["--version", "1.0.0\n"],
    ["--uat"],
    ["--uat", "2"],
    ["--uat=0"],
    ["--bump"],
    ["--bump=patch"],
    ["--version", "1.0.1", "--bump=rc"],
    ["--version", "--uat=1"],
    ["--uat=1", "--uat=0"],
    ["--unknown"],
    ["1.0.1"],
    ["--help=true"],
    ["--unify=true"],
    ["--unify", "--unify"],
    ["--rc=1"],
    ["--rc", "--minor"],
    ["--bump=major", "--hotfix"],
    ["--major", "--bump=major"],
    ["--version=1.0.1", "--hotfix"],
    ["--minor", "--version=1.0.1"],
  ];
  for (const args of invalid) expect(() => parseCliOptions(args)).toThrow();
});

test("parses bump shortcuts and computes their release targets", async () => {
  const { cwd, config, fetch } = fixture();
  git(cwd, "tag", "1.0.0-rc.5");
  for (const [flag, bump, expected] of [
    ["--rc", "rc", "1.0.0-rc.6"],
    ["--hotfix", "bugfix", "1.0.1-rc.1"],
    ["--minor", "minor", "1.1.0-rc.1"],
    ["--major", "major", "2.0.0-rc.1"],
  ] as const) {
    const options = parseCliOptions([flag, "--uat", "1", "--unify"]);
    expect(options).toMatchObject({ bump, unify: true });
    expect(await planRelease(config, fetch, cwd, options)).toMatchObject({ rcTag: expected });
  }
  expect(parseCliOptions(["--unify"]).unify).toBe(true);
});

for (const unify of [true, false]) {
  test(`differing mono versions ${unify ? "unify automatically" : "still ask for a choice"}`, async () => {
    const { cwd, config, fetch } = fixture();
    git(cwd, "tag", "1.0.0");
    config.type = "mono";
    config.subprojectsDir = "apps";
    config.subprojects = ["frontend", "backend"].map((repo) => ({ repo, enabled: true }));
    for (const [name, version] of [
      ["frontend", "1.2.0"],
      ["backend", "2.0.0"],
    ]) {
      mkdirSync(join(cwd, "apps", name as string), { recursive: true });
      writeFileSync(
        join(cwd, "apps", name as string, "package.json"),
        JSON.stringify({ name, version }),
      );
    }
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "packages with differing versions");
    if (!unify) selections.push("separate");
    await flowNewRelease(
      fetch,
      config,
      cwd,
      { includeUmbrella: true, repos: ["frontend", "backend"] },
      parseCliOptions(["--minor", "--uat=1", ...(unify ? ["--unify"] : [])]),
    );
    const versionAt = (file: string) => JSON.parse(readFileSync(join(cwd, file), "utf8")).version;
    expect(versionAt("package.json")).toBe(unify ? "2.1.0-rc.1" : "1.1.0-rc.1");
    expect(versionAt("apps/frontend/package.json")).toBe(unify ? "2.1.0-rc.1" : "1.3.0-rc.1");
    expect(versionAt("apps/backend/package.json")).toBe("2.1.0-rc.1");
    expect(selections).toEqual([]);
    expect(confirmations).toEqual(["Proceed?"]);
  });
}

test("plans explicit RC, final, mixed tiers, and version conversions", async () => {
  const { cwd, config, fetch } = fixture();
  git(cwd, "tag", "1.0.0");
  const rc = await planRelease(
    config,
    fetch,
    cwd,
    parseCliOptions(["--version=1.0.1-rc.6", "--uat=1"]),
  );
  expect(rc).toMatchObject({
    rcTag: "1.0.1-rc.6",
    finalTag: null,
    selectedEnvs: ["uat"],
    mergePairedEnv: false,
  });
  expect(
    await planRelease(config, fetch, cwd, { version: "1.0.1", environments: ["uat"] }),
  ).toMatchObject({ rcTag: "1.0.1-rc.1" });
  expect(
    await planRelease(config, fetch, cwd, { version: "1.0.1-rc.6", environments: ["production"] }),
  ).toMatchObject({ rcTag: null, finalTag: "1.0.1" });
  expect(
    await planRelease(config, fetch, cwd, {
      bump: "minor",
      environments: ["staging", "production"],
    }),
  ).toMatchObject({ rcTag: "1.1.0-rc.1", finalTag: "1.1.0" });
});

test("prompts only for omitted choices", async () => {
  const { cwd, config, fetch } = fixture();
  selections.push("uat");
  expect(await planRelease(config, fetch, cwd, { version: "1.0.1-rc.6" })).toMatchObject({
    selectedEnvs: ["uat"],
  });
  selections.push("minor");
  expect(await planRelease(config, fetch, cwd, { environments: ["production"] })).toMatchObject({
    finalTag: "0.1.0",
  });
  expect(selections).toEqual([]);
});

test("unify leaves matching versions alone and still prompts for omitted environment and bump", async () => {
  const { cwd, config, fetch } = fixture();
  git(cwd, "tag", "1.0.0");
  config.type = "mono";
  config.subprojectsDir = "apps";
  config.subprojects = [{ repo: "frontend", enabled: true }];
  mkdirSync(join(cwd, "apps/frontend"), { recursive: true });
  writeFileSync(join(cwd, "apps/frontend/package.json"), '{"version":"1.0.0"}');
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "matching package version");
  selections.push("uat", "minor");
  cancelConfirmation = true;
  expect(
    await flowNewRelease(
      fetch,
      config,
      cwd,
      { includeUmbrella: true, repos: ["frontend"] },
      parseCliOptions(["--unify"]),
    ),
  ).toBe(BACK);
  expect(selections).toEqual([]);
  // Unification only bypasses the version-conflict question.
  expect(confirmations).toEqual(["Also merge into staging for all selected repos?"]);
});

test("validates configured environments, existing prefixed tags, and downgrade targets", async () => {
  const { cwd, config, fetch } = fixture();
  config.environments.uat = null;
  await expect(
    planRelease(config, fetch, cwd, { version: "1.0.1", environments: ["uat"] }),
  ).rejects.toThrow("not configured");
  config.tag_prefix = "v";
  git(cwd, "tag", "v1.0.1");
  await expect(
    planRelease(config, fetch, cwd, { version: "1.0.1-rc.6", environments: ["production"] }),
  ).rejects.toThrow('Tag "v1.0.1" already exists');
  await expect(
    planRelease(config, fetch, cwd, { version: "1.0.0", environments: ["production"] }),
  ).rejects.toThrow("greater than current latest");
  await expect(
    planRelease(config, fetch, cwd, { bump: "rc", environments: ["production"] }),
  ).rejects.toThrow("requires staging or uat");
});

test("the CLI handles help/version and rejects invalid input before repository checks", () => {
  const cli = join(import.meta.dir, "../src/cli.ts");
  for (const [args, status, message] of [
    [["--help"], 0, "Usage: xeploy"],
    [["--version"], 0, VERSION],
    [["--uat", "2"], 1, "--uat requires 1 or 0"],
    [["--version", "bad"], 1, "Version must be"],
    [["--uat=1", "--unknown"], 1, "Unknown argument"],
  ] as const) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: tmpdir(), encoding: "utf8" });
    expect(result.status).toBe(status);
    expect(result.stdout + result.stderr).toContain(message);
    expect(result.stdout + result.stderr).not.toContain("gh CLI is not authenticated");
  }
});

test("cancelling confirmation returns without mutations", async () => {
  const { cwd, config, fetch } = fixture();
  cancelConfirmation = true;
  expect(
    await flowNewRelease(
      fetch,
      config,
      cwd,
      { includeUmbrella: true, repos: [] },
      { version: "1.0.1", environments: ["production"] },
    ),
  ).toBe(BACK);
  expect(git(cwd, "status", "--porcelain")).toBe("");
  expect(confirmations).toEqual(["Proceed?"]);
});

test("executes an RC release locally and never recreates excluded paired branches", async () => {
  const { cwd, config, fetch, remote } = fixture();
  git(cwd, "push", "origin", "--delete", "staging");
  git(cwd, "branch", "-D", "staging");
  await flowNewRelease(
    fetch,
    config,
    cwd,
    { includeUmbrella: true, repos: [] },
    parseCliOptions(["--version", "1.0.1-rc.6", "--uat", "1"]),
  );
  expect(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version).toBe("1.0.1-rc.6");
  expect(git(remote, "rev-parse", "refs/heads/uat")).toBe(git(cwd, "rev-parse", "HEAD"));
  expect(git(cwd, "branch", "--list", "staging")).toBe("");
  expect(confirmations).toEqual(["Proceed?"]);
  expect(summaries.some((summary) => summary.includes("Environments: uat"))).toBe(true);
});

test("executes a final mono release and preserves unselected package versions", async () => {
  const { cwd, config, fetch } = fixture();
  config.type = "mono";
  config.subprojectsDir = "apps";
  config.subprojects = ["frontend", "backend"].map((repo) => ({ repo, enabled: true }));
  for (const name of ["frontend", "backend"]) {
    mkdirSync(join(cwd, "apps", name), { recursive: true });
    writeFileSync(
      join(cwd, "apps", name, "package.json"),
      JSON.stringify({ name, version: "1.0.0" }),
    );
  }
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "packages");
  await flowNewRelease(
    fetch,
    config,
    cwd,
    { includeUmbrella: true, repos: ["frontend"] },
    { version: "1.0.1", environments: ["production"] },
  );
  expect(JSON.parse(readFileSync(join(cwd, "apps/frontend/package.json"), "utf8")).version).toBe(
    "1.0.1",
  );
  expect(JSON.parse(readFileSync(join(cwd, "apps/backend/package.json"), "utf8")).version).toBe(
    "1.0.0",
  );
  expect(git(cwd, "status", "--porcelain")).toBe("");
});

test("rejects a mono package downgrade before writing any versions", async () => {
  const { cwd, config, fetch } = fixture();
  config.type = "mono";
  config.subprojectsDir = "apps";
  config.subprojects = [{ repo: "frontend", enabled: true }];
  mkdirSync(join(cwd, "apps/frontend"), { recursive: true });
  writeFileSync(join(cwd, "apps/frontend/package.json"), '{"version":"2.0.0"}');
  await expect(
    flowNewRelease(
      fetch,
      config,
      cwd,
      { includeUmbrella: true, repos: ["frontend"] },
      { version: "1.0.1", environments: ["production"] },
    ),
  ).rejects.toThrow("frontend: Version");
  expect(confirmations).toEqual([]);
  expect(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version).toBe("1.0.0");
});

test("validates every selected meta repository before releasing the first", async () => {
  const root = fixture();
  const sub = fixture();
  git(sub.cwd, "tag", "1.0.1-rc.6");
  git(sub.cwd, "push", "origin", "--tags");
  git(root.cwd, "-c", "protocol.file.allow=always", "submodule", "add", sub.remote, "frontend");
  git(root.cwd, "commit", "-am", "submodule");
  root.config.type = "meta";
  root.config.subprojects = [{ repo: "frontend", enabled: true }];
  await expect(
    flowNewRelease(
      root.fetch,
      root.config,
      root.cwd,
      { includeUmbrella: true, repos: ["frontend"] },
      { version: "1.0.1-rc.6", environments: ["uat"] },
    ),
  ).rejects.toThrow('frontend: Tag "1.0.1-rc.6" already exists');
  expect(confirmations).toEqual([]);
  expect(git(root.cwd, "status", "--porcelain")).toBe("");
});

test("executes meta RC and final tiers in order across submodule and umbrella", async () => {
  const root = fixture();
  const sub = fixture();
  git(root.cwd, "-c", "protocol.file.allow=always", "submodule", "add", sub.remote, "frontend");
  git(root.cwd, "commit", "-am", "submodule");
  const subCwd = join(root.cwd, "frontend");
  git(subCwd, "config", "user.name", "Xeploy Test");
  git(subCwd, "config", "user.email", "test@example.invalid");
  git(subCwd, "config", "commit.gpgsign", "false");
  root.config.type = "meta";
  root.config.subprojects = [{ repo: "frontend", enabled: true }];
  await flowNewRelease(
    root.fetch,
    root.config,
    root.cwd,
    { includeUmbrella: true, repos: ["frontend"] },
    { version: "1.0.1-rc.6", environments: ["uat", "production"] },
  );
  for (const cwd of [root.cwd, subCwd]) {
    expect(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version).toBe("1.0.1");
    expect(git(cwd, "status", "--porcelain")).toBe("");
    expect(JSON.parse(git(cwd, "show", "origin/uat:package.json")).version).toBe("1.0.1-rc.6");
    expect(git(cwd, "rev-parse", "refs/remotes/origin/main")).toBe(git(cwd, "rev-parse", "HEAD"));
  }
  expect(confirmations).toEqual(["Proceed?"]);
});
