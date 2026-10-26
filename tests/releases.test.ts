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
const texts: string[] = [];
const confirmations: string[] = [];
const summaries: string[] = [];
let cancelConfirmation = false;
mock.module("@clack/prompts", () => ({
  select: async () => {
    if (!selections.length) throw new Error("Unexpected selection prompt");
    return selections.shift();
  },
  text: async () => {
    if (!texts.length) throw new Error("Unexpected text prompt");
    return texts.shift();
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
  texts.length = 0;
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

test("mixed mono release bumps VERSION umbrella, Python API, and Flutter app with one commit", async () => {
  const { cwd, config, fetch } = fixture();
  rmSync(join(cwd, "package.json"));
  writeFileSync(join(cwd, "VERSION"), "1.0.0\n");
  mkdirSync(join(cwd, "apps/api"), { recursive: true });
  mkdirSync(join(cwd, "apps/mobile"), { recursive: true });
  writeFileSync(join(cwd, "apps/api/pyproject.toml"), '[project]\nname="api"\nversion="1.0.0"\n');
  writeFileSync(join(cwd, "apps/mobile/pubspec.yaml"), "name: mobile\nversion: 1.0.0+42\n");
  config.type = "mono";
  config.subprojectsDir = "apps";
  config.subprojects = [
    { repo: "api", enabled: true },
    { repo: "mobile", enabled: true },
  ];
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "mixed projects");
  const before = Number(git(cwd, "rev-list", "--count", "HEAD"));
  await flowNewRelease(
    fetch,
    config,
    cwd,
    { includeUmbrella: true, repos: ["api", "mobile"] },
    { version: "1.1.0-rc.1", environments: ["uat"] },
  );
  expect(readFileSync(join(cwd, "VERSION"), "utf8")).toBe("1.1.0-rc.1\n");
  expect(readFileSync(join(cwd, "apps/api/pyproject.toml"), "utf8")).toContain(
    'version="1.1.0rc1"',
  );
  expect(readFileSync(join(cwd, "apps/mobile/pubspec.yaml"), "utf8")).toContain(
    "version: 1.1.0-rc.1+43",
  );
  expect(Number(git(cwd, "rev-list", "--count", "HEAD"))).toBe(before + 1);
  expect(git(cwd, "status", "--porcelain")).toBe("");
});

test("mixed project preflight rejects unsupported computed child before confirmation or mutation", async () => {
  const { cwd, config, fetch } = fixture();
  mkdirSync(join(cwd, "apps/api"), { recursive: true });
  writeFileSync(
    join(cwd, "apps/api/pyproject.toml"),
    '[project]\nname="api"\ndynamic=["version"]\n',
  );
  config.type = "mono";
  config.subprojectsDir = "apps";
  config.subprojects = [{ repo: "api", enabled: true }];
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "computed child");
  const before = git(cwd, "rev-parse", "HEAD");
  await expect(
    flowNewRelease(
      fetch,
      config,
      cwd,
      { includeUmbrella: true, repos: ["api"] },
      { version: "1.1.0", environments: ["production"] },
    ),
  ).rejects.toThrow("static version");
  expect(confirmations).toEqual([]);
  expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
  expect(git(cwd, "status", "--porcelain")).toBe("");
});

test("shared-source updates cannot silently change unselected projects", async () => {
  const { cwd, config, fetch } = fixture();
  writeFileSync(
    join(cwd, "Directory.Build.props"),
    "<Project><PropertyGroup><Version>1.0.0</Version></PropertyGroup></Project>",
  );
  for (const name of ["a", "b"]) {
    mkdirSync(join(cwd, "apps", name), { recursive: true });
    writeFileSync(join(cwd, "apps", name, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk"/>');
  }
  config.type = "mono";
  config.subprojectsDir = "apps";
  config.project = { ecosystem: "javascript" };
  config.subprojects = ["a", "b"].map((repo) => ({ repo, enabled: true }));
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "shared versions");
  await expect(
    flowNewRelease(
      fetch,
      config,
      cwd,
      { includeUmbrella: false, repos: ["a"] },
      { version: "1.1.0", environments: ["production"] },
    ),
  ).rejects.toThrow("unselected");
  expect(confirmations).toEqual([]);
  expect(readFileSync(join(cwd, "Directory.Build.props"), "utf8")).toContain(
    "<Version>1.0.0</Version>",
  );
});

test("a single selected mixed app bumps from its own version when umbrella is excluded", async () => {
  const { cwd, config, fetch } = fixture();
  mkdirSync(join(cwd, "apps/mobile"), { recursive: true });
  writeFileSync(join(cwd, "apps/mobile/pubspec.yaml"), "name: mobile\nversion: 3.2.0+17\n");
  config.type = "mono";
  config.subprojectsDir = "apps";
  config.subprojects = [{ repo: "mobile", enabled: true }];
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "mobile");
  await flowNewRelease(
    fetch,
    config,
    cwd,
    { includeUmbrella: false, repos: ["mobile"] },
    { bump: "minor", environments: ["production"] },
  );
  expect(readFileSync(join(cwd, "apps/mobile/pubspec.yaml"), "utf8")).toContain(
    "version: 3.3.0+18",
  );
  expect(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version).toBe("1.0.0");
});

test("mixed meta releases resolve submodule names separately from paths and complete both tiers", async () => {
  const root = fixture();
  const sub = fixture();
  rmSync(join(root.cwd, "package.json"));
  writeFileSync(
    join(root.cwd, "App.csproj"),
    "<Project><PropertyGroup><Version>1.0.0</Version></PropertyGroup></Project>",
  );
  rmSync(join(sub.cwd, "package.json"));
  writeFileSync(join(sub.cwd, "pubspec.yaml"), "name: mobile\nversion: 1.0.0+42\n");
  mkdirSync(join(sub.cwd, "ios"));
  writeFileSync(join(sub.cwd, "ios/README.md"), "Apple target");
  git(sub.cwd, "add", ".");
  git(sub.cwd, "commit", "-m", "flutter app");
  git(sub.cwd, "push", "origin", "develop");
  git(
    root.cwd,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--name",
    "mobile",
    sub.remote,
    "clients/mobile",
  );
  git(root.cwd, "add", ".");
  git(root.cwd, "commit", "-m", "dotnet umbrella and mobile module");
  const mobileCwd = join(root.cwd, "clients/mobile");
  git(mobileCwd, "config", "user.name", "Xeploy Test");
  git(mobileCwd, "config", "user.email", "test@example.invalid");
  git(mobileCwd, "config", "commit.gpgsign", "false");
  root.config.type = "meta";
  root.config.subprojects = [{ repo: "mobile", enabled: true }];
  await flowNewRelease(
    root.fetch,
    root.config,
    root.cwd,
    { includeUmbrella: true, repos: ["mobile"] },
    { version: "1.1.0-rc.1", environments: ["uat", "production"] },
  );
  expect(readFileSync(join(root.cwd, "App.csproj"), "utf8")).toContain("<Version>1.1.0</Version>");
  expect(readFileSync(join(mobileCwd, "pubspec.yaml"), "utf8")).toContain("version: 1.1.0+44");
  expect(git(mobileCwd, "show", "origin/uat:pubspec.yaml")).toContain("version: 1.1.0+43");
  expect(git(root.cwd, "status", "--porcelain")).toBe("");
  expect(git(mobileCwd, "status", "--porcelain")).toBe("");
});

test("Go module tags target the committed release and never move existing tags", async () => {
  const { cwd, remote } = fixture();
  const { createModuleTags } = await import("../src/project-release.js");
  const { goModuleTag } = await import("../src/go-project.js");
  const { resolveProject } = await import("../src/projects.js");
  mkdirSync(join(cwd, "apps/sdk/v2"), { recursive: true });
  writeFileSync(
    join(cwd, "apps/sdk/v2/go.mod"),
    "module example.com/repo/apps/sdk/v2\n\ngo 1.23\n",
  );
  const tag = goModuleTag(resolveProject(cwd, "apps/sdk/v2"), "2.1.0");
  expect(tag).toBe("apps/sdk/v2.1.0");
  createModuleTags(cwd, [tag]);
  const head = git(cwd, "rev-parse", "HEAD");
  expect(git(remote, "rev-parse", `refs/tags/${tag}`)).toBe(head);
  createModuleTags(cwd, [tag]);
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "new revision");
  expect(() => createModuleTags(cwd, [tag])).toThrow("different commit");
  expect(git(remote, "rev-parse", `refs/tags/${tag}`)).toBe(head);
});

test("Go import-path migration is rejected before any release commit", async () => {
  const { cwd, config, fetch } = fixture();
  rmSync(join(cwd, "package.json"));
  writeFileSync(join(cwd, "go.mod"), "module example.com/sdk\n\ngo 1.23\n");
  writeFileSync(join(cwd, "VERSION"), "1.0.0\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "go module");
  const before = git(cwd, "rev-parse", "HEAD");
  await expect(
    flowNewRelease(
      fetch,
      config,
      cwd,
      { includeUmbrella: true, repos: [] },
      { bump: "major", environments: ["production"] },
    ),
  ).rejects.toThrow("import-path migration");
  expect(confirmations).toEqual([]);
  expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
  expect(git(cwd, "status", "--porcelain")).toBe("");
});

test("automatic mono bumps reject an existing release tag before changing files", async () => {
  const { cwd, config, fetch } = fixture();
  config.type = "mono";
  config.subprojectsDir = "apps";
  config.subprojects = [{ repo: "mobile", enabled: true }];
  mkdirSync(join(cwd, "apps/mobile"), { recursive: true });
  writeFileSync(join(cwd, "apps/mobile/pubspec.yaml"), "version: 1.0.0+1\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "mobile");
  git(cwd, "tag", "1.1.0");
  await expect(
    flowNewRelease(
      fetch,
      config,
      cwd,
      { includeUmbrella: true, repos: ["mobile"] },
      { bump: "minor", environments: ["production"] },
    ),
  ).rejects.toThrow('Tag "1.1.0" already exists');
  expect(confirmations).toEqual([]);
  expect(readFileSync(join(cwd, "apps/mobile/pubspec.yaml"), "utf8")).toContain("1.0.0+1");
});

test("an empty project selection performs no release or confirmation", async () => {
  const { cwd, config, fetch } = fixture();
  config.type = "mono";
  const before = git(cwd, "rev-parse", "HEAD");
  await flowNewRelease(
    fetch,
    config,
    cwd,
    { includeUmbrella: false, repos: [] },
    { version: "1.1.0", environments: ["production"] },
  );
  expect(confirmations).toEqual([]);
  expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
});

test("interactive source selection persists explicit ecosystem overrides", async () => {
  const { cwd, config } = fixture();
  const { configureProjectSources } = await import("../src/project-setup.js");
  const { loadConfig } = await import("../src/config.js");
  writeFileSync(
    join(cwd, "App.csproj"),
    "<Project><PropertyGroup><Version>2.0.0</Version></PropertyGroup></Project>",
  );
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  selections.push({ ecosystem: "dotnet", file: "App.csproj" });
  try {
    await configureProjectSources(config, cwd);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
  expect(loadConfig(cwd)?.project).toEqual({ ecosystem: "dotnet", version_file: "App.csproj" });
  expect(selections).toEqual([]);
  expect(() => readFileSync(join(cwd, ".xeploy-state.json"))).toThrow();
});

test("VERSION initialization uses applicable tags and refuses to guess without a terminal", async () => {
  const { cwd, config } = fixture();
  const { configureProjectSources } = await import("../src/project-setup.js");
  rmSync(join(cwd, "package.json"));
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  try {
    await expect(configureProjectSources(config, cwd)).rejects.toThrow("initial_version");
    git(cwd, "tag", "1.2.3");
    await configureProjectSources(config, cwd);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
  expect(config.project?.initial_version).toBe("1.2.3");
  expect(() => readFileSync(join(cwd, "VERSION"))).toThrow();
});

test("recognized Python SCM providers read tags without executing Python and require tag releases", async () => {
  const { cwd, config, fetch } = fixture();
  const { resolveProject, readProjectVersion, prepareProjectVersion } = await import(
    "../src/projects.js"
  );
  rmSync(join(cwd, "package.json"));
  writeFileSync(
    join(cwd, "pyproject.toml"),
    '[project]\nname="api"\ndynamic=["version"]\n[tool.setuptools_scm]\nversion_file="generated.py"\n',
  );
  writeFileSync(join(cwd, "generated.py"), 'raise RuntimeError("do not execute or edit")\n');
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "SCM version");
  git(cwd, "tag", "v1.0.0");
  const project = resolveProject(cwd);
  expect(readProjectVersion(project)).toBe("1.0.0");
  expect(prepareProjectVersion(project, "1.1.0").map((edit) => edit.path)).toContain("VERSION");
  await expect(
    flowNewRelease(
      fetch,
      config,
      cwd,
      { includeUmbrella: true, repos: [] },
      { version: "1.1.0", environments: ["production"] },
    ),
  ).rejects.toThrow("requires create_tag");
  expect(confirmations).toEqual([]);
  expect(readFileSync(join(cwd, "generated.py"), "utf8")).toContain("do not execute or edit");
});

test("public execution validates all tiers before confirmation or file mutations", async () => {
  const { executeReleasePlan } = await import("../src/flows.js");
  const { cwd, config } = fixture();
  rmSync(join(cwd, "package.json"));
  writeFileSync(join(cwd, "pubspec.yaml"), "version: 1.0.0+2099999999\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "Flutter fixture");
  const before = git(cwd, "rev-parse", "HEAD");
  await expect(
    executeReleasePlan(
      {
        selectedEnvs: ["uat", "production"],
        rcTag: "1.1.0-rc.1",
        finalTag: "1.1.0",
        mergePairedEnv: false,
      },
      config,
      cwd,
      [],
    ),
  ).rejects.toThrow("platform limit");
  expect(confirmations).toEqual([]);
  expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
});

test("an unrelated unresolved unselected project does not block a subset release", async () => {
  const { cwd, config, fetch } = fixture();
  config.type = "mono";
  config.subprojectsDir = "apps";
  config.subprojects = [
    { repo: "a", enabled: true },
    { repo: "b", enabled: true },
  ];
  mkdirSync(join(cwd, "apps/a"), { recursive: true });
  mkdirSync(join(cwd, "apps/b"), { recursive: true });
  writeFileSync(join(cwd, "apps/a/VERSION"), "1.0.0\n");
  writeFileSync(join(cwd, "apps/b/setup.py"), "setup(version=calculate_version())\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "mixed fixture");
  await flowNewRelease(
    fetch,
    config,
    cwd,
    { includeUmbrella: true, repos: ["a"] },
    { version: "1.1.0", environments: ["production"] },
  );
  expect(readFileSync(join(cwd, "apps/a/VERSION"), "utf8")).toBe("1.1.0\n");
  expect(readFileSync(join(cwd, "apps/b/setup.py"), "utf8")).toBe(
    "setup(version=calculate_version())\n",
  );
});

test("remote push failures resume the frozen release without incrementing Flutter twice", async () => {
  const { resumeRelease } = await import("../src/flows.js");
  const { cwd, remote, config, fetch } = fixture();
  rmSync(join(cwd, "package.json"));
  writeFileSync(join(cwd, "pubspec.yaml"), "version: 1.0.0+7\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "Flutter fixture");
  git(cwd, "push", "origin", "develop");
  const hook = join(remote, "hooks/pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await expect(
    flowNewRelease(fetch, config, cwd, undefined, {
      version: "1.1.0",
      environments: ["production"],
    }),
  ).rejects.toThrow();
  expect(readFileSync(join(cwd, "pubspec.yaml"), "utf8")).toBe("version: 1.1.0+8\n");
  const released = git(cwd, "rev-parse", "HEAD");
  rmSync(hook);
  await resumeRelease(cwd);
  expect(git(cwd, "rev-parse", "HEAD")).toBe(released);
  expect(git(cwd, "rev-parse", "origin/main")).toBe(released);
  expect(readFileSync(join(cwd, "pubspec.yaml"), "utf8")).toBe("version: 1.1.0+8\n");
  await expect(resumeRelease(cwd)).rejects.toThrow("No pending");
});

test("resume is an exclusive CLI operation", () => {
  expect(parseCliOptions(["--resume"])).toMatchObject({ resume: true });
  for (const args of [
    ["--resume=1"],
    ["--resume", "--major"],
    ["--resume", "--version"],
    ["--resume", "--production", "1"],
  ])
    expect(() => parseCliOptions(args)).toThrow();
});

test("an environment push failure remains pending and resumes without another version commit", async () => {
  const { resumeRelease } = await import("../src/flows.js");
  const { cwd, remote, config, fetch } = fixture();
  const hook = join(remote, "hooks/pre-receive");
  writeFileSync(
    hook,
    '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = "refs/heads/main" ]; then exit 1; fi\ndone\n',
    { mode: 0o755 },
  );
  await expect(
    flowNewRelease(fetch, config, cwd, undefined, {
      version: "1.1.0",
      environments: ["production"],
    }),
  ).rejects.toThrow("resume");
  const commit = git(cwd, "rev-parse", "HEAD");
  expect(git(cwd, "rev-parse", "origin/main")).not.toBe(commit);
  rmSync(hook);
  await resumeRelease(cwd);
  expect(git(cwd, "rev-parse", "origin/main")).toBe(commit);
  expect(git(cwd, "rev-parse", "HEAD")).toBe(commit);
});

test("historical meta promotion uses recorded child commits and preserves newer develop work", async () => {
  const { flowOldRelease } = await import("../src/flows.js");
  const root = fixture();
  const child = fixture();
  const stable = fixture();
  rmSync(join(child.cwd, "package.json"));
  writeFileSync(join(child.cwd, "pubspec.yaml"), "version: 1.1.0-rc.1+43\n");
  git(child.cwd, "add", ".");
  git(child.cwd, "commit", "-m", "RC mobile");
  git(child.cwd, "tag", "v1.1.0-rc.1");
  git(child.cwd, "push", "origin", "develop", "--tags");
  rmSync(join(root.cwd, "package.json"));
  writeFileSync(join(root.cwd, "VERSION"), "1.1.0-rc.1\n");
  git(
    root.cwd,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--name",
    "stable",
    stable.remote,
    "clients/stable",
  );
  git(
    root.cwd,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--name",
    "mobile",
    child.remote,
    "clients/mobile",
  );
  const mobile = join(root.cwd, "clients/mobile");
  git(mobile, "config", "user.name", "Xeploy Test");
  git(mobile, "config", "user.email", "test@example.invalid");
  git(mobile, "config", "commit.gpgsign", "false");
  git(root.cwd, "add", ".");
  git(root.cwd, "commit", "-m", "umbrella RC");
  git(root.cwd, "tag", "v1.1.0-rc.1");
  writeFileSync(join(mobile, "pubspec.yaml"), "version: 1.2.0+99\n");
  git(mobile, "add", ".");
  git(mobile, "commit", "-m", "newer mobile work");
  git(mobile, "push", "origin", "develop");
  writeFileSync(join(root.cwd, "VERSION"), "1.2.0\n");
  writeFileSync(join(root.cwd, "newer.txt"), "keep on develop\n");
  git(root.cwd, "add", ".");
  git(root.cwd, "commit", "-m", "newer umbrella work");
  const latest = git(root.cwd, "rev-parse", "HEAD");
  const childLatest = git(mobile, "rev-parse", "HEAD");
  root.config.type = "meta";
  root.config.tag_prefix = "v";
  root.config.subprojects = [
    { repo: "stable", enabled: true },
    { repo: "mobile", enabled: true },
  ];
  selections.push("1.1.0-rc.1", "promote");
  await flowOldRelease(root.fetch, root.config, root.cwd);
  expect(git(root.cwd, "show", "origin/main:VERSION")).toBe("1.1.0");
  expect(git(mobile, "show", "origin/main:pubspec.yaml")).toBe("version: 1.1.0+44");
  expect(git(root.cwd, "rev-parse", "HEAD")).toBe(latest);
  expect(git(mobile, "rev-parse", "HEAD")).toBe(childLatest);
  expect(git(root.cwd, "status", "--porcelain")).toBe("");
  expect(git(root.cwd, "ls-tree", "origin/main", "newer.txt")).toBe("");
  const fake = fakeGithub(root.dir);
  root.config.create_tag = true;
  try {
    selections.push("1.1.0-rc.1", "republish");
    await flowOldRelease(root.fetch, root.config, root.cwd);
    expect(JSON.parse(readFileSync(fake.state, "utf8")).creates).toBe(2);
    expect(git(root.cwd, "rev-parse", "HEAD")).toBe(latest);
    expect(readFileSync(join(mobile, "pubspec.yaml"), "utf8")).toBe("version: 1.2.0+99\n");
  } finally {
    fake.restore();
  }
});

function fakeGithub(dir: string, failAfterCreate = false) {
  const bin = join(dir, "fake-bin");
  mkdirSync(bin);
  const state = join(dir, "github.json");
  const failure = join(dir, "fail-gh");
  writeFileSync(state, JSON.stringify({ releases: {}, creates: 0, deletes: 0 }));
  if (failAfterCreate) writeFileSync(failure, "once");
  writeFileSync(
    join(bin, "gh"),
    `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const file=${JSON.stringify(state)};const fail=${JSON.stringify(failure)};const data=JSON.parse(fs.readFileSync(file));const key=process.cwd()+':'+args[2];if(args[0]==='release'){if(args[1]==='view'){if(!data.releases[key])process.exit(1);console.log('{}');}if(args[1]==='create'){if(data.releases[key])process.exit(1);data.releases[key]=true;data.creates++;fs.writeFileSync(file,JSON.stringify(data));if(fs.existsSync(fail)){fs.unlinkSync(fail);process.exit(1);}}if(args[1]==='delete'){delete data.releases[key];data.deletes++;fs.writeFileSync(file,JSON.stringify(data));}}else if(args[0]==='pr'&&args[1]==='list')console.log('[]');\n`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  return {
    state,
    restore: () => {
      process.env.PATH = oldPath;
    },
  };
}

test("GitHub creation with an unknown outcome resumes without moving tags or recreating releases", async () => {
  const { resumeRelease } = await import("../src/flows.js");
  const { cwd, dir, config, fetch } = fixture();
  const fake = fakeGithub(dir, true);
  config.create_tag = true;
  try {
    await expect(
      flowNewRelease(fetch, config, cwd, undefined, {
        version: "1.1.0-rc.1",
        environments: ["uat"],
      }),
    ).rejects.toThrow("resume");
    const commit = git(cwd, "rev-parse", "HEAD");
    const tag = git(cwd, "rev-parse", "refs/tags/1.1.0-rc.1");
    await resumeRelease(cwd);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(commit);
    expect(git(cwd, "rev-parse", "refs/tags/1.1.0-rc.1")).toBe(tag);
    expect(JSON.parse(readFileSync(fake.state, "utf8")).creates).toBe(1);
  } finally {
    fake.restore();
  }
});

test("republishing an old RC preserves counters and publishes its existing tag commit", async () => {
  const { flowOldRelease } = await import("../src/flows.js");
  const { cwd, dir, config, fetch } = fixture();
  const fake = fakeGithub(dir);
  config.create_tag = true;
  try {
    rmSync(join(cwd, "package.json"));
    writeFileSync(join(cwd, "pubspec.yaml"), "version: 1.0.0+7\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "mobile fixture");
    await flowNewRelease(fetch, config, cwd, undefined, {
      version: "1.1.0-rc.1",
      environments: ["uat"],
    });
    const released = git(cwd, "rev-parse", "HEAD");
    writeFileSync(join(cwd, "newer.txt"), "new work");
    git(cwd, "add", ".");
    git(cwd, "commit", "-m", "unreleased work");
    const latest = git(cwd, "rev-parse", "HEAD");
    selections.push("1.1.0-rc.1", "republish");
    await flowOldRelease(fetch, config, cwd);
    expect(git(cwd, "rev-parse", "refs/tags/1.1.0-rc.1")).toBe(released);
    expect(git(cwd, "rev-parse", "HEAD")).toBe(latest);
    expect(readFileSync(join(cwd, "pubspec.yaml"), "utf8")).toBe("version: 1.1.0-rc.1+8\n");
    expect(JSON.parse(readFileSync(fake.state, "utf8"))).toMatchObject({ creates: 2, deletes: 1 });
  } finally {
    fake.restore();
  }
});

test("partial meta releases resume completed children and then finish both tiers", async () => {
  const { resumeRelease, executeReleasePlan } = await import("../src/flows.js");
  const root = fixture();
  const a = fixture();
  const b = fixture();
  rmSync(join(root.cwd, "package.json"));
  writeFileSync(join(root.cwd, "VERSION"), "1.0.0\n");
  for (const [name, child] of [
    ["a", a],
    ["b", b],
  ] as const) {
    rmSync(join(child.cwd, "package.json"));
    writeFileSync(join(child.cwd, "pubspec.yaml"), "version: 1.0.0+7\n");
    git(child.cwd, "add", ".");
    git(child.cwd, "commit", "-m", "mobile fixture");
    git(child.cwd, "push", "origin", "develop");
    git(
      root.cwd,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--name",
      name,
      child.remote,
      `apps/${name}`,
    );
    const local = join(root.cwd, `apps/${name}`);
    git(local, "config", "user.name", "Xeploy Test");
    git(local, "config", "user.email", "test@example.invalid");
    git(local, "config", "commit.gpgsign", "false");
  }
  git(root.cwd, "add", ".");
  git(root.cwd, "commit", "-m", "meta fixture");
  root.config.type = "meta";
  root.config.subprojects = [
    { repo: "a", enabled: true },
    { repo: "b", enabled: true },
  ];
  const hook = join(b.remote, "hooks/pre-receive");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await expect(
    executeReleasePlan(
      {
        selectedEnvs: ["uat", "production"],
        rcTag: "1.1.0-rc.1",
        finalTag: "1.1.0",
        mergePairedEnv: false,
      },
      root.config,
      root.cwd,
      [],
    ),
  ).rejects.toThrow("resume");
  const first = git(join(root.cwd, "apps/a"), "rev-parse", "HEAD");
  rmSync(hook);
  await resumeRelease(root.cwd);
  expect(git(join(root.cwd, "apps/a"), "rev-parse", "HEAD~1")).toBe(first);
  for (const name of ["a", "b"])
    expect(readFileSync(join(root.cwd, `apps/${name}/pubspec.yaml`), "utf8")).toBe(
      "version: 1.1.0+9\n",
    );
  expect(readFileSync(join(root.cwd, "VERSION"), "utf8")).toBe("1.1.0\n");
  expect(git(root.cwd, "status", "--porcelain")).toBe("");
});

test("public execution rejects existing tags before confirmation or commits", async () => {
  const { executeReleasePlan } = await import("../src/flows.js");
  const { cwd, config } = fixture();
  git(cwd, "tag", "1.1.0");
  const before = git(cwd, "rev-parse", "HEAD");
  await expect(
    executeReleasePlan(
      { selectedEnvs: ["production"], rcTag: null, finalTag: "1.1.0", mergePairedEnv: false },
      config,
      cwd,
      [],
    ),
  ).rejects.toThrow("already exists");
  expect(confirmations).toEqual([]);
  expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
});

for (const unify of [false, true])
  test(`mixed Python/Go meta versions ${unify ? "unify" : "remain independent"}`, async () => {
    const root = fixture();
    const child = fixture();
    rmSync(join(root.cwd, "package.json"));
    writeFileSync(
      join(root.cwd, "pyproject.toml"),
      '[project]\nname="umbrella"\nversion="1.0.0"\n',
    );
    rmSync(join(child.cwd, "package.json"));
    writeFileSync(join(child.cwd, "go.mod"), "module example.com/sdk/v2\ngo 1.22\n");
    writeFileSync(join(child.cwd, "VERSION"), "2.0.0\n");
    git(child.cwd, "add", ".");
    git(child.cwd, "commit", "-m", "Go fixture");
    git(child.cwd, "push", "origin", "develop");
    git(
      root.cwd,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--name",
      "sdk",
      child.remote,
      "modules/sdk",
    );
    const sdk = join(root.cwd, "modules/sdk");
    git(sdk, "config", "user.name", "Xeploy Test");
    git(sdk, "config", "user.email", "test@example.invalid");
    git(sdk, "config", "commit.gpgsign", "false");
    git(root.cwd, "add", ".");
    git(root.cwd, "commit", "-m", "mixed fixture");
    root.config.type = "meta";
    root.config.subprojects = [{ repo: "sdk", enabled: true }];
    if (!unify) selections.push("separate");
    await flowNewRelease(
      root.fetch,
      root.config,
      root.cwd,
      { includeUmbrella: true, repos: ["sdk"] },
      { bump: "minor", environments: ["production"], unify },
    );
    expect(readFileSync(join(root.cwd, "pyproject.toml"), "utf8")).toContain(
      `version="${unify ? "2.1.0" : "1.1.0"}"`,
    );
    expect(readFileSync(join(sdk, "VERSION"), "utf8")).toBe("2.1.0\n");
    expect(git(root.cwd, "status", "--porcelain")).toBe("");
  });

test("Python SCM baselines ignore tags on unrelated branches", async () => {
  const { resolveProject, readProjectVersion } = await import("../src/projects.js");
  const { cwd } = fixture();
  rmSync(join(cwd, "package.json"));
  writeFileSync(
    join(cwd, "pyproject.toml"),
    '[project]\ndynamic=["version"]\n[tool.setuptools_scm]\n',
  );
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "SCM fixture");
  git(cwd, "tag", "v1.0.0");
  git(cwd, "checkout", "-b", "future");
  writeFileSync(join(cwd, "future.txt"), "future");
  git(cwd, "add", ".");
  git(cwd, "commit", "-m", "future work");
  git(cwd, "tag", "v9.0.0");
  git(cwd, "checkout", "develop");
  expect(readProjectVersion(resolveProject(cwd))).toBe("1.0.0");
});

test("manifestless initialization prompts once and scopes Go child tags", async () => {
  const { configureProjectSources } = await import("../src/project-setup.js");
  const { cwd, config } = fixture();
  rmSync(join(cwd, "package.json"));
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  try {
    texts.push("0.1.0");
    await configureProjectSources(config, cwd);
  } finally {
    if (descriptor) Object.defineProperty(process.stdin, "isTTY", descriptor);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  }
  expect(config.project?.initial_version).toBe("0.1.0");
  mkdirSync(join(cwd, "packages/sdk/v2"), { recursive: true });
  writeFileSync(join(cwd, "packages/sdk/v2/go.mod"), "module example.com/sdk/v2\ngo 1.22\n");
  git(cwd, "tag", "packages/sdk/v2.1.0");
  git(cwd, "tag", "other/v9.0.0");
  config.type = "mono";
  config.subprojects = [{ repo: "sdk", path: "packages/sdk/v2", enabled: true }];
  await configureProjectSources(config, cwd, { includeUmbrella: false, repos: ["sdk"] });
  expect(config.subprojects[0]?.project?.initial_version).toBe("2.1.0");
  expect(() => readFileSync(join(cwd, "packages/sdk/v2/VERSION"))).toThrow();
});

test("detached meta children release through a matching integration branch", async () => {
  const root = fixture();
  const child = fixture();
  git(
    root.cwd,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    "--name",
    "app",
    child.remote,
    "apps/app",
  );
  git(root.cwd, "add", ".");
  git(root.cwd, "commit", "-m", "meta fixture");
  const app = join(root.cwd, "apps/app");
  git(app, "config", "user.name", "Xeploy Test");
  git(app, "config", "user.email", "test@example.invalid");
  git(app, "config", "commit.gpgsign", "false");
  git(app, "checkout", "--detach", "HEAD");
  root.config.type = "meta";
  root.config.subprojects = [{ repo: "app", enabled: true }];
  await flowNewRelease(
    root.fetch,
    root.config,
    root.cwd,
    { includeUmbrella: false, repos: ["app"] },
    { version: "1.1.0", environments: ["production"] },
  );
  expect(git(app, "branch", "--show-current")).toBe("develop");
  expect(git(app, "rev-parse", "origin/develop")).toBe(git(app, "rev-parse", "HEAD"));
  expect(JSON.parse(readFileSync(join(root.cwd, "package.json"), "utf8")).version).toBe("1.0.0");
  expect(git(root.cwd, "status", "--porcelain")).toBe("");
});

test("production release-branch push failures stay pending until that branch is published", async () => {
  const { resumeRelease } = await import("../src/flows.js");
  const { cwd, remote, config, fetch } = fixture();
  config.create_production_release_branch = true;
  const hook = join(remote, "hooks/pre-receive");
  writeFileSync(
    hook,
    '#!/bin/sh\nwhile read old new ref; do\ncase "$ref" in refs/heads/release/*) exit 1;; esac\ndone\n',
    { mode: 0o755 },
  );
  await expect(
    flowNewRelease(fetch, config, cwd, undefined, {
      version: "1.1.0",
      environments: ["production"],
    }),
  ).rejects.toThrow("resume");
  const commit = git(cwd, "rev-parse", "HEAD");
  rmSync(hook);
  await resumeRelease(cwd);
  expect(git(cwd, "rev-parse", "origin/release/1.1.0")).toBe(commit);
  expect(git(cwd, "rev-parse", "origin/main")).toBe(commit);
});

test("annotated historical tags can be republished without moving their commits", async () => {
  const { republishRc } = await import("../src/git.js");
  const { cwd, dir } = fixture();
  const fake = fakeGithub(dir);
  try {
    git(cwd, "tag", "-a", "1.1.0-rc.1", "-m", "RC");
    const object = git(cwd, "rev-parse", "refs/tags/1.1.0-rc.1");
    republishRc("1.1.0-rc.1", { cwd, generateReleaseNotes: false });
    expect(git(cwd, "rev-parse", "refs/tags/1.1.0-rc.1")).toBe(object);
    expect(JSON.parse(readFileSync(fake.state, "utf8")).creates).toBe(1);
  } finally {
    fake.restore();
  }
});
