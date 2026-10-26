import * as fs from "node:fs";
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { detectRepoType, detectSubprojectsDir } from "../src/config.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "xeploy-projects-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  return root;
}

test("discovers a manifestless mixed monorepo with Flutter and Python children", () => {
  const root = fixture({
    "apps/mobile/pubspec.yaml":
      "name: mobile\nversion: 1.2.3+42\ndependencies:\n  flutter:\n    sdk: flutter\n",
    "apps/api/pyproject.toml": '[project]\nname = "api"\nversion = "2.0.0"\n',
  });
  expect(detectRepoType(root)).toBe("mono");
  expect(detectSubprojectsDir(root)).toBe("apps");
});

import { applyFileEdits } from "../src/project-edits.js";
import { prepareProjectVersion, readProjectVersion, resolveProject } from "../src/projects.js";

test("preparing Flutter versions is read-only and preserves nested values and CRLF comments", () => {
  const original =
    "name: mobile\r\nversion: '1.2.3+42' # release\r\ndependencies:\r\n  other:\r\n    version: 9.0.0\r\n";
  const root = fixture({ "pubspec.yaml": original });
  const project = resolveProject(root);
  expect(project.ecosystem).toBe("flutter");
  expect(readProjectVersion(project)).toBe("1.2.3");
  const edits = prepareProjectVersion(project, "1.2.4-rc.1");
  expect(readFileSync(join(root, "pubspec.yaml"), "utf8")).toBe(original);
  expect(edits[0]?.after).toBe(original.replace("1.2.3+42", "1.2.4-rc.1+43"));
  applyFileEdits(root, edits);
  expect(prepareProjectVersion(project, "1.2.4-rc.1")).toEqual([]);
});

test("VERSION fallback plans creation without writing during discovery", () => {
  const root = fixture({ "README.md": "manifestless" });
  const project = resolveProject(root);
  expect(project.ecosystem).toBe("generic");
  expect(readProjectVersion(project)).toBeNull();
  const edits = prepareProjectVersion(project, "0.1.0-rc.1");
  expect(existsSync(join(root, "VERSION"))).toBe(false);
  applyFileEdits(root, edits);
  expect(readFileSync(join(root, "VERSION"), "utf8")).toBe("0.1.0-rc.1\n");
});

test("stale source batches fail before changing any file", () => {
  const root = fixture({ VERSION: "1.0.0\n", "package.json": '{"version":"1.0.0"}' });
  const version = resolveProject(root, ".", { ecosystem: "generic", version_file: "VERSION" });
  const edits = [
    ...prepareProjectVersion(version, "1.1.0"),
    ...prepareProjectVersion(resolveProject(root), "1.1.0"),
  ];
  writeFileSync(join(root, "package.json"), '{"version":"2.0.0"}');
  expect(() => applyFileEdits(root, edits)).toThrow("changed since planning");
  expect(readFileSync(join(root, "VERSION"), "utf8")).toBe("1.0.0\n");
});

test("Python prereleases normalize and update only project metadata", () => {
  const raw =
    '# application\n[project]\nname = "api"\nversion = "1.2.3rc2" # candidate\n[tool.other]\nversion = "9.0.0"\n';
  const root = fixture({ "pyproject.toml": raw });
  const project = resolveProject(root);
  expect(readProjectVersion(project)).toBe("1.2.3-rc.2");
  const edits = prepareProjectVersion(project, "1.2.3-rc.3");
  expect(edits[0]?.after).toBe(raw.replace("1.2.3rc2", "1.2.3rc3"));
});

test(".NET inherits shared VersionPrefix/Suffix without touching dependencies", () => {
  const raw =
    '<Project><PropertyGroup><VersionPrefix>1.2.3</VersionPrefix><VersionSuffix>rc.2</VersionSuffix></PropertyGroup><ItemGroup><PackageReference Include="Other" Version="9.0.0" /></ItemGroup></Project>';
  const root = fixture({
    "Directory.Build.props": raw,
    "apps/api/Api.csproj":
      '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
  });
  const project = resolveProject(root, "apps/api");
  expect(readProjectVersion(project)).toBe("1.2.3-rc.2");
  const edits = prepareProjectVersion(project, "1.3.0");
  expect(edits[0]?.path).toBe("Directory.Build.props");
  expect(edits[0]?.after).toContain(
    "<VersionPrefix>1.3.0</VersionPrefix><VersionSuffix></VersionSuffix>",
  );
  expect(edits[0]?.after).toContain('Version="9.0.0"');
});

test("Rust workspace inheritance updates the owning version declaration", () => {
  const root = fixture({
    "Cargo.toml": '[workspace]\nmembers = ["apps/cli"]\n[workspace.package]\nversion = "1.0.0"\n',
    "apps/cli/Cargo.toml":
      '[package]\nname = "cli"\nversion.workspace = true\n[dependencies]\nother = "9"\n',
  });
  const project = resolveProject(root, "apps/cli");
  expect(readProjectVersion(project)).toBe("1.0.0");
  expect(prepareProjectVersion(project, "1.1.0-rc.1")[0]).toMatchObject({ path: "Cargo.toml" });
});

test("Java resolves Maven revision properties and Gradle literal versions without executing scripts", () => {
  const root = fixture({
    "maven/pom.xml":
      "<project><modelVersion>4.0.0</modelVersion><version>${revision}</version><properties><revision>1.2.3</revision></properties><dependencies><dependency><version>9.0.0</version></dependency></dependencies></project>",
    "gradle/build.gradle.kts": 'plugins { java }\nversion = "2.0.0"\n',
  });
  const maven = resolveProject(root, "maven");
  expect(readProjectVersion(maven)).toBe("1.2.3");
  expect(prepareProjectVersion(maven, "1.3.0")[0]?.after).toContain("<revision>1.3.0</revision>");
  expect(prepareProjectVersion(maven, "1.3.0")[0]?.after).toContain(
    "<dependency><version>9.0.0</version></dependency>",
  );
  const gradle = resolveProject(root, "gradle");
  expect(readProjectVersion(gradle)).toBe("2.0.0");
  expect(prepareProjectVersion(gradle, "2.1.0")[0]?.after).toBe(
    'plugins { java }\nversion = "2.1.0"\n',
  );
});

test("Unity game versions preserve YAML and increment platform counters only once", () => {
  const raw =
    "%YAML 1.1\n--- !u!129 &1\nPlayerSettings:\n  bundleVersion: 1.0.0\n  AndroidBundleVersionCode: 12\n  buildNumber:\n    Standalone: 4\n    iPhone: 8\n    tvOS: 3\n";
  const root = fixture({ "ProjectSettings/ProjectSettings.asset": raw });
  const project = resolveProject(root);
  expect(readProjectVersion(project)).toBe("1.0.0");
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.1"));
  const changed = readFileSync(join(root, "ProjectSettings/ProjectSettings.asset"), "utf8");
  expect(changed).toContain("bundleVersion: 1.1.0\n");
  expect(readProjectVersion(project)).toBe("1.1.0-rc.1");
  expect(changed).toContain("AndroidBundleVersionCode: 13");
  expect(changed).toContain("iPhone: 9");
  expect(prepareProjectVersion(project, "1.1.0-rc.1")).toEqual([]);
});

test("Godot updates application and export preset values as one validated batch", () => {
  const root = fixture({
    "project.godot": '[application]\nconfig/name="Game"\nconfig/version="1.0.0"\n',
    "export_presets.cfg":
      '[preset.0]\nplatform="Android"\n[preset.0.options]\nversion/name="1.0.0"\nversion/code=42\n[preset.1]\nplatform="iOS"\n[preset.1.options]\napplication/short_version="1.0.0"\napplication/version="5.2.1"\n',
  });
  const project = resolveProject(root);
  const edits = prepareProjectVersion(project, "1.1.0-rc.1");
  applyFileEdits(root, edits);
  expect(readFileSync(join(root, "export_presets.cfg"), "utf8")).toContain("version/code=43");
  expect(readFileSync(join(root, "export_presets.cfg"), "utf8")).toContain(
    'application/short_version="1.1.0"',
  );
  expect(readFileSync(join(root, "export_presets.cfg"), "utf8")).toContain(
    'application/version="5.2.2"',
  );
  expect(readProjectVersion(project)).toBe("1.1.0-rc.1");
  expect(prepareProjectVersion(project, "1.1.0-rc.1")).toEqual([]);
});

test("Unreal plugin and game versions leave engine compatibility and Android offsets intact", () => {
  const root = fixture({
    "plugin/Example.uplugin": '{"Version":7,"VersionName":"1.0.0","EngineVersion":"5.4.0"}',
    "game/Game.uproject": "{}",
    "game/Config/DefaultGame.ini":
      "[/Script/EngineSettings.GeneralProjectSettings]\nProjectVersion=1.0.0\n",
    "game/Config/DefaultEngine.ini":
      "[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]\nStoreVersion=12\nStoreVersionOffsetArm64=100\nVersionDisplayName=1.0.0\n",
  });
  const plugin = resolveProject(root, "plugin");
  expect(readProjectVersion(plugin)).toBe("1.0.0");
  const pluginEdits = prepareProjectVersion(plugin, "1.1.0");
  expect(pluginEdits[0]?.after).toBe('{"Version":8,"VersionName":"1.1.0","EngineVersion":"5.4.0"}');
  const game = resolveProject(root, "game");
  applyFileEdits(root, prepareProjectVersion(game, "1.1.0-rc.1"));
  expect(readFileSync(join(root, "game/Config/DefaultEngine.ini"), "utf8")).toContain(
    "StoreVersion=13\nStoreVersionOffsetArm64=100",
  );
});

test("Go uses VERSION instead of go.mod dependency/toolchain versions and stops major migrations", () => {
  const root = fixture({
    "apps/sdk/go.mod":
      "module example.com/repo/apps/sdk\n\ngo 1.23\nrequire example.com/dep v9.0.0\n",
    "apps/sdk/VERSION": "1.2.3\n",
  });
  const project = resolveProject(root, "apps/sdk");
  expect(project.ecosystem).toBe("go");
  expect(readProjectVersion(project)).toBe("1.2.3");
  expect(() => prepareProjectVersion(project, "2.0.0")).toThrow("import-path migration");
  expect(prepareProjectVersion(project, "1.3.0")[0]?.path).toBe("apps/sdk/VERSION");
});

test("Flutter Apple projects keep numeric build names and retain canonical RC identity across retries", () => {
  const root = fixture({
    "pubspec.yaml": "name: mobile\nversion: 1.0.0+42\n",
    "ios/Runner/Info.plist":
      "<plist><dict><key>CFBundleShortVersionString</key><string>$(FLUTTER_BUILD_NAME)</string></dict></plist>",
  });
  const project = resolveProject(root);
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.1"));
  expect(readFileSync(join(root, "pubspec.yaml"), "utf8")).toContain("version: 1.1.0+43");
  expect(readProjectVersion(project)).toBe("1.1.0-rc.1");
  expect(prepareProjectVersion(project, "1.1.0-rc.1")).toEqual([]);
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0"));
  expect(readFileSync(join(root, "pubspec.yaml"), "utf8")).toContain("version: 1.1.0+44");
});

test("source resolution rejects symlink escape and malformed manifests instead of falling back", () => {
  const root = fixture({ "apps/a/package.json": '{"version": ' });
  expect(() => readProjectVersion(resolveProject(root, "apps/a"))).toThrow();
  expect(() => resolveProject(root, "../outside")).toThrow("escapes repo root");
});

test(".NET platform versions use native numeric fields and increment application build numbers", () => {
  const raw =
    "<Project><PropertyGroup><Version>1.0.0</Version><FileVersion>1.0.0.7</FileVersion><AssemblyVersion>1.0.0.0</AssemblyVersion><ApplicationDisplayVersion>1.0.0</ApplicationDisplayVersion><ApplicationVersion>42</ApplicationVersion></PropertyGroup></Project>";
  const root = fixture({ "App.csproj": raw });
  applyFileEdits(root, prepareProjectVersion(resolveProject(root), "1.1.0-rc.1"));
  const changed = readFileSync(join(root, "App.csproj"), "utf8");
  expect(changed).toContain("<Version>1.1.0-rc.1</Version>");
  expect(changed).toContain("<FileVersion>1.1.0.8</FileVersion>");
  expect(changed).toContain("<ApplicationVersion>43</ApplicationVersion>");
  expect(changed).toContain("<ApplicationDisplayVersion>1.1.0</ApplicationDisplayVersion>");
});

test("manifest without a version uses VERSION while dynamic declarations remain errors", () => {
  const root = fixture({
    "plain/package.json": '{"name":"umbrella"}',
    "dynamic/pyproject.toml": '[project]\nname="api"\ndynamic=["version"]\n',
  });
  const plain = resolveProject(root, "plain");
  expect(plain.versionFile).toBe("VERSION");
  expect(prepareProjectVersion(plain, "0.1.0")[0]?.path).toBe("plain/VERSION");
  expect(() => readProjectVersion(resolveProject(root, "dynamic"))).toThrow("static version");
});

test("counter overflow is rejected for both RC and final tiers before any writes", () => {
  const root = fixture({ "pubspec.yaml": "name: mobile\nversion: 1.0.0+2099999999\n" });
  const project = resolveProject(root);
  expect(prepareProjectVersion(project, "1.1.0-rc.1")[0]?.after).toContain("+2100000000");
  expect(() => prepareProjectVersion(project, "1.1.0", 2)).toThrow("limit");
  expect(readFileSync(join(root, "pubspec.yaml"), "utf8")).toContain("+2099999999");
});

test("broken VERSION symlinks cannot redirect new files outside the repository", () => {
  const root = fixture({ "README.md": "root" });
  const outside = fixture({ "README.md": "outside" });
  symlinkSync(join(outside, "not-created"), join(root, "VERSION"));
  expect(() =>
    prepareProjectVersion(
      resolveProject(root, ".", { ecosystem: "generic", version_file: "VERSION" }),
      "1.0.0",
    ),
  ).toThrow();
  expect(existsSync(join(outside, "not-created"))).toBe(false);
});

test("Python duplicate metadata and static attribute providers remain synchronized", () => {
  const root = fixture({
    "both/pyproject.toml": '[project]\nversion="1.0.0"\n[tool.poetry]\nversion="1.0.0"\n',
    "attribute/pyproject.toml":
      '[project]\ndynamic=["version"]\n[tool.setuptools.dynamic]\nversion={attr="api.__version__"}\n',
    "attribute/src/api/__init__.py": '# __version__ = "9.0.0"\n__version__ = "1.0.0"\n',
  });
  const both = resolveProject(root, "both");
  applyFileEdits(root, prepareProjectVersion(both, "1.1.0-rc.1"));
  expect(readProjectVersion(both)).toBe("1.1.0-rc.1");
  const attribute = resolveProject(root, "attribute");
  expect(readProjectVersion(attribute)).toBe("1.0.0");
  const changed = prepareProjectVersion(attribute, "1.1.0");
  expect(changed[0]?.after).toBe('# __version__ = "9.0.0"\n__version__ = "1.1.0"\n');
});

test("Maven parent inheritance updates the selected child's parent version binding", () => {
  const root = fixture({
    "pom.xml":
      "<project><groupId>example</groupId><artifactId>root</artifactId><version>1.0.0</version></project>",
    "apps/api/pom.xml":
      "<project><parent><groupId>example</groupId><artifactId>root</artifactId><version>1.0.0</version><relativePath>../../pom.xml</relativePath></parent><artifactId>api</artifactId></project>",
  });
  const project = resolveProject(root, "apps/api");
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0"));
  expect(readFileSync(join(root, "pom.xml"), "utf8")).toContain("<version>1.1.0</version>");
  expect(readFileSync(join(root, "apps/api/pom.xml"), "utf8")).toContain(
    "<version>1.1.0</version>",
  );
});

test("Rust bumps local lockfile metadata without changing registry packages", () => {
  const root = fixture({
    "Cargo.toml": '[package]\nname="cli"\nversion="1.0.0"\n',
    "Cargo.lock":
      '# lock\nversion = 3\n[[package]]\nname = "cli"\nversion = "1.0.0"\n[[package]]\nname = "cli"\nversion = "9.0.0"\nsource = "registry+https://example.invalid"\nchecksum = "unchanged"\n',
  });
  applyFileEdits(root, prepareProjectVersion(resolveProject(root), "1.1.0"));
  expect(readFileSync(join(root, "Cargo.lock"), "utf8")).toBe(
    '# lock\nversion = 3\n[[package]]\nname = "cli"\nversion = "1.1.0"\n[[package]]\nname = "cli"\nversion = "9.0.0"\nsource = "registry+https://example.invalid"\nchecksum = "unchanged"\n',
  );
});

test("setuptools setup.cfg file and attribute directives resolve their backing source", () => {
  const root = fixture({
    "file/setup.cfg": "[metadata]\nname = api\nversion = file: VERSION\n",
    "file/VERSION": "1.0.0\n",
    "attr/setup.cfg": "[metadata]\nversion = attr: api.__version__\n",
    "attr/api.py": '__version__ = "2.0.0"\n',
  });
  expect(readProjectVersion(resolveProject(root, "file"))).toBe("1.0.0");
  expect(prepareProjectVersion(resolveProject(root, "file"), "1.1.0")[0]?.path).toBe(
    "file/VERSION",
  );
  expect(readProjectVersion(resolveProject(root, "attr"))).toBe("2.0.0");
});

for (const [label, files, ecosystem, expected] of [
  [
    "Poetry",
    { "pyproject.toml": '[tool.poetry]\nname="api"\nversion="1.0.0"\n' },
    "python",
    "1.0.0",
  ],
  [
    "setup.py",
    {
      "setup.py":
        'from setuptools import setup\nsetup(name="api", version="1.0.0")\nraise RuntimeError("must not execute")\n',
    },
    "python",
    "1.0.0",
  ],
  ["setup.cfg", { "setup.cfg": "[metadata]\nversion=1.0.0\n" }, "python", "1.0.0"],
  [
    "F#",
    { "App.fsproj": "<Project><PropertyGroup><Version>1.0.0</Version></PropertyGroup></Project>" },
    "dotnet",
    "1.0.0",
  ],
  [
    "Gradle Groovy",
    { "build.gradle": "version = '1.0.0'\nthrow new Exception('must not execute')\n" },
    "java",
    "1.0.0",
  ],
  ["Gradle properties", { "gradle.properties": "version=1.0.0\n" }, "java", "1.0.0"],
  ["Godot addon", { "plugin.cfg": '[plugin]\nname="addon"\nversion="1.0.0"\n' }, "godot", "1.0.0"],
  [
    "Unity package",
    { "package.json": '{"name":"com.example.package","version":"1.0.0","unity":"2022.3"}' },
    "javascript",
    "1.0.0",
  ],
] as const) {
  test(`${label} manifest updates without executing project code`, () => {
    const root = fixture(files);
    const project = resolveProject(root);
    expect(project.ecosystem).toBe(ecosystem);
    expect(readProjectVersion(project)).toBe(expected);
    applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.1"));
    expect(readProjectVersion(project)).toBe("1.1.0-rc.1");
  });
}

test("explicit Unity package selection uses JSON package versions", () => {
  const root = fixture({
    "package.json": '{"name":"com.example.tool","version":"1.0.0","unity":"2022.3"}',
  });
  const project = resolveProject(root, ".", { ecosystem: "unity", version_file: "package.json" });
  expect(readProjectVersion(project)).toBe("1.0.0");
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.1"));
  expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toMatchObject({
    version: "1.1.0-rc.1",
    unity: "2022.3",
  });
});

test("an engine umbrella can discover mixed apps while excluding generated engine projects", () => {
  const root = fixture({
    "project.godot": '[application]\nconfig/version="1.0.0"\n',
    "Generated.csproj": "<Project/>",
    "apps/mobile/pubspec.yaml": "name: mobile\nversion: 1.0.0+1\n",
    ".godot/generated/package.json": '{"version":"9.0.0"}',
  });
  expect(detectRepoType(root)).toBe("mono");
  expect(detectSubprojectsDir(root)).toBe("apps");
});

test("discovery retains projects across apps and services instead of choosing one container", () => {
  const root = fixture({
    "apps/mobile/pubspec.yaml": "version: 1.0.0+1\n",
    "services/api/pyproject.toml": '[project]\nversion="1.0.0"\n',
  });
  expect(detectSubprojectsDir(root)).toBeNull();
});

test("explicit platform bindings update native values and can override automatic field limits", () => {
  const root = fixture({
    "pubspec.yaml": "version: 1.0.0+42\n",
    "ios/Runner/Info.plist":
      "<plist><dict><key>CFBundleShortVersionString</key><string>1.0.0</string><key>CFBundleVersion</key><string>8</string></dict></plist>",
    "versions.json": '{"windows":"1.0.0.7"}',
  });
  const project = resolveProject(root, ".", {
    platform_fields: [
      {
        file: "ios/Runner/Info.plist",
        format: "plist",
        key: "CFBundleVersion",
        kind: "apple-counter",
        limit: 10,
      },
      { file: "versions.json", format: "json", key: "windows", kind: "numeric4" },
    ],
  });
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.1"));
  expect(readFileSync(join(root, "versions.json"), "utf8")).toBe('{"windows":"1.1.0.8"}');
  expect(readFileSync(join(root, "ios/Runner/Info.plist"), "utf8")).toContain("<string>9</string>");
  expect(prepareProjectVersion(project, "1.1.0-rc.1")).toEqual([]);
});

test("a partial write restores every affected file and allows a successful retry", () => {
  const root = fixture({ "a/VERSION": "1.0.0\n", "b/VERSION": "1.0.0\n" });
  const edits = ["a", "b"].flatMap((directory) =>
    prepareProjectVersion(resolveProject(root, directory), "1.1.0"),
  );
  const original = fs.writeFileSync;
  let interrupted = false;
  const writer = spyOn(fs, "writeFileSync").mockImplementation(
    (...args: Parameters<typeof fs.writeFileSync>) => {
      if (String(args[0]) === join(root, "b/VERSION") && !interrupted) {
        interrupted = true;
        original(args[0], "partially written");
        throw new Error("simulated write failure");
      }
      return original(...args);
    },
  );
  try {
    expect(() => applyFileEdits(root, edits)).toThrow("simulated write failure");
    expect(readFileSync(join(root, "a/VERSION"), "utf8")).toBe("1.0.0\n");
    expect(readFileSync(join(root, "b/VERSION"), "utf8")).toBe("1.0.0\n");
  } finally {
    writer.mockRestore();
  }
  applyFileEdits(root, edits);
  expect(readFileSync(join(root, "a/VERSION"), "utf8")).toBe("1.1.0\n");
  expect(readFileSync(join(root, "b/VERSION"), "utf8")).toBe("1.1.0\n");
});

test("Gradle properties do not hide the build script's authoritative version", () => {
  const root = fixture({
    "gradle.properties": "org.gradle.jvmargs=-Xmx2g\n",
    "build.gradle.kts": 'plugins { java }\nversion = "1.2.3"\n',
  });
  const project = resolveProject(root);
  expect(readProjectVersion(project)).toBe("1.2.3");
  expect(prepareProjectVersion(project, "1.3.0")[0]?.path).toBe("build.gradle.kts");
});

test("computed setup.py versions cannot silently become disconnected VERSION files", () => {
  const root = fixture({
    "setup.py": "from setuptools import setup\nsetup(version=compute_version())\n",
  });
  expect(() => readProjectVersion(resolveProject(root))).toThrow("static version");
  expect(existsSync(join(root, "VERSION"))).toBe(false);
});

test("default Unity and MAUI display versions normalize to release identity", () => {
  const root = fixture({
    "unity/ProjectSettings/ProjectSettings.asset": "PlayerSettings:\n  bundleVersion: 0.1\n",
    "maui/App.csproj":
      "<Project><PropertyGroup><ApplicationDisplayVersion>1.0</ApplicationDisplayVersion><ApplicationVersion>42</ApplicationVersion></PropertyGroup></Project>",
  });
  expect(readProjectVersion(resolveProject(root, "unity"))).toBe("0.1.0");
  const maui = resolveProject(root, "maui");
  expect(readProjectVersion(maui)).toBe("1.0.0");
  applyFileEdits(root, prepareProjectVersion(maui, "1.1.0-rc.1"));
  expect(readFileSync(join(root, "maui/App.csproj"), "utf8")).toContain(
    "<ApplicationDisplayVersion>1.1.0</ApplicationDisplayVersion><ApplicationVersion>43</ApplicationVersion>",
  );
  expect(readProjectVersion(maui)).toBe("1.1.0-rc.1");
});

test("Unreal four-part game versions retain their numeric revision and canonical identity", () => {
  const root = fixture({
    "Game.uproject": "{}",
    "Config/DefaultGame.ini":
      "[/Script/EngineSettings.GeneralProjectSettings]\nProjectVersion=1.0.0.7\n",
  });
  const project = resolveProject(root);
  expect(readProjectVersion(project)).toBe("1.0.0");
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.1"));
  expect(readFileSync(join(root, "Config/DefaultGame.ini"), "utf8")).toContain(
    "ProjectVersion=1.1.0.8",
  );
  expect(readProjectVersion(project)).toBe("1.1.0-rc.1");
  expect(prepareProjectVersion(project, "1.1.0-rc.1")).toEqual([]);
});

test("symlinked version aliases are rejected so staging cannot miss the changed target", () => {
  const root = fixture({ VERSION: "1.0.0\n" });
  symlinkSync("VERSION", join(root, "alias-version"));
  expect(() =>
    resolveProject(root, ".", { ecosystem: "generic", version_file: "alias-version" }),
  ).toThrow("symlink");
  expect(readFileSync(join(root, "VERSION"), "utf8")).toBe("1.0.0\n");
});

test("legacy multi-file bumps also validate every source before writing", async () => {
  const { bumpVersionFiles } = await import("../src/versions.js");
  const root = fixture({ "package.json": '{"version":"1.0.0"}' });
  expect(() => bumpVersionFiles("1.1.0", ["package.json", "missing.json"], root)).toThrow(
    "not found",
  );
  expect(readFileSync(join(root, "package.json"), "utf8")).toBe('{"version":"1.0.0"}');
});

test("Flutter counters support large Apple build numbers and enforce Windows bounds", () => {
  for (const [platform, count] of [["windows", 65535]] as const) {
    const root = fixture({
      "pubspec.yaml": `version: 1.0.0+${count}\n`,
      [`${platform}/README.md`]: "native target",
    });
    expect(() => prepareProjectVersion(resolveProject(root), "1.1.0")).toThrow("platform limit");
    expect(readFileSync(join(root, "pubspec.yaml"), "utf8")).toContain(`+${count}`);
  }
});

test("Apple build counters do not impose archived digit-width restrictions", () => {
  const root = fixture({
    "pubspec.yaml": "version: 1.0.0+2026102601\n",
    "ios/README.md": "Apple target",
  });
  const edits = prepareProjectVersion(resolveProject(root), "1.1.0");
  expect(edits[0]?.after).toContain("version: 1.1.0+2026102602");
});

test("version bindings cannot overwrite Git's internal metadata", () => {
  const root = fixture({
    "package.json": '{"version":"1.0.0"}',
    ".git/config": "[project]\nversion=1.0.0\n",
  });
  const project = resolveProject(root, ".", {
    platform_fields: [
      { file: ".git/config", format: "ini", section: "project", key: "version", kind: "release" },
    ],
  });
  expect(() => prepareProjectVersion(project, "1.1.0")).toThrow("Git metadata");
  expect(readFileSync(join(root, ".git/config"), "utf8")).toContain("version=1.0.0");
});

test(".NET local versions override shared defaults and Prefix creates a separate RC suffix", () => {
  const root = fixture({
    "Directory.Build.props":
      "<Project><PropertyGroup><Version>9.0.0</Version></PropertyGroup></Project>",
    "App.csproj": "<Project><PropertyGroup><Version>1.0.0</Version></PropertyGroup></Project>",
  });
  const project = resolveProject(root);
  expect(readProjectVersion(project)).toBe("1.0.0");
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.1"));
  expect(readFileSync(join(root, "App.csproj"), "utf8")).toContain("<Version>1.1.0-rc.1</Version>");
  expect(readFileSync(join(root, "Directory.Build.props"), "utf8")).toContain(
    "<Version>9.0.0</Version>",
  );
  expect(readProjectVersion(project)).toBe("1.1.0-rc.1");
  const prefixRoot = fixture({
    "App.csproj":
      "<Project><PropertyGroup><VersionPrefix>1.0.0</VersionPrefix></PropertyGroup></Project>",
  });
  expect(prepareProjectVersion(resolveProject(prefixRoot), "1.1.0-rc.1")[0]?.after).toContain(
    "<VersionPrefix>1.1.0</VersionPrefix><VersionSuffix>rc.1</VersionSuffix>",
  );
});

test(".NET property-backed versions preserve expressions and reject conditions", () => {
  const root = fixture({
    "Directory.Build.props":
      "<Project><PropertyGroup><ReleaseVersion>1.0.0</ReleaseVersion></PropertyGroup></Project>",
    "App.csproj":
      "<Project><PropertyGroup><Version>$(ReleaseVersion)</Version><InformationalVersion>$(Version)+$(SourceRevisionId)</InformationalVersion></PropertyGroup></Project>",
    "conditional/App.csproj":
      '<Project><PropertyGroup Condition="release"><Version>1.0.0</Version></PropertyGroup></Project>',
  });
  const project = resolveProject(root);
  expect(readProjectVersion(project)).toBe("1.0.0");
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0"));
  expect(readFileSync(join(root, "Directory.Build.props"), "utf8")).toContain(
    "<ReleaseVersion>1.1.0</ReleaseVersion>",
  );
  expect(readFileSync(join(root, "App.csproj"), "utf8")).toContain(
    "<Version>$(ReleaseVersion)</Version>",
  );
  expect(() => readProjectVersion(resolveProject(root, "conditional"))).toThrow("Conditional");
});

test("setuptools dynamic file arrays and module literals are read without evaluation", () => {
  const root = fixture({
    "pyproject.toml":
      '[project]\ndynamic=["version"]\n[tool.setuptools.dynamic]\nversion = {file = ["VERSION.txt"]}\n',
    "VERSION.txt": "1.0.0rc2\r\n",
  });
  const project = resolveProject(root);
  expect(readProjectVersion(project)).toBe("1.0.0-rc.2");
  expect(prepareProjectVersion(project, "1.0.0-rc.3")[0]?.after).toBe("1.0.0rc3\r\n");
});

test("Python typed module attributes ignore nested and commented lookalikes", () => {
  const root = fixture({
    "pyproject.toml":
      '[project]\ndynamic=["version"]\n[tool.setuptools.dynamic]\nversion={attr="api.__version__"}\n',
    "api.py":
      '# __version__ = "9.0.0"\ndef hidden():\n  __version__ = "8.0.0"\n__version__: str = "1.0.0"\n',
  });
  const project = resolveProject(root);
  expect(readProjectVersion(project)).toBe("1.0.0");
  const edits = prepareProjectVersion(project, "1.1.0");
  expect(edits[0]?.after).toContain('__version__: str = "1.1.0"');
  expect(edits[0]?.after).toContain('  __version__ = "8.0.0"');
});

test("conflicting, cyclic and malformed native sources stop without edits", () => {
  for (const [file, raw, error] of [
    [
      "App.csproj",
      "<Project><PropertyGroup><Version>$(A)</Version><A>$(B)</A><B>$(A)</B></PropertyGroup></Project>",
      "Cyclic",
    ],
    [
      "App.csproj",
      "<Project><PropertyGroup><Version>1.0.0</Wrong></PropertyGroup></Project>",
      "Malformed",
    ],
    [
      "pyproject.toml",
      '[project]\nversion="1.0.0"\n[tool.poetry]\nversion="2.0.0"\n',
      "Conflicting",
    ],
    [
      "pyproject.toml",
      '[project]\ndynamic=["version"]\n[tool.unknown]\nsource="execute-this"\n',
      "static version",
    ],
  ]) {
    const root = fixture({ [file as string]: raw as string });
    expect(() => prepareProjectVersion(resolveProject(root), "1.1.0")).toThrow(error);
    expect(readFileSync(join(root, file as string), "utf8")).toBe(raw);
  }
});

test("Maven CI-friendly revision and changelist properties preserve their bindings", () => {
  const raw =
    "<project><version>${revision}${changelist}</version><properties><revision>1.0.0</revision><changelist>-rc.1</changelist></properties><dependencies><dependency><version>9.0.0</version></dependency></dependencies></project>";
  const root = fixture({ "pom.xml": raw });
  const project = resolveProject(root);
  expect(readProjectVersion(project)).toBe("1.0.0-rc.1");
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.2"));
  expect(readFileSync(join(root, "pom.xml"), "utf8")).toBe(
    raw.replace(
      "<revision>1.0.0</revision><changelist>-rc.1</changelist>",
      "<revision>1.1.0</revision><changelist>-rc.2</changelist>",
    ),
  );
  expect(readProjectVersion(project)).toBe("1.1.0-rc.2");
});

test("Rust workspace batches merge shared versions and local lockfile entries", async () => {
  const { prepareRepositoryVersions } = await import("../src/project-release.js");
  const root = fixture({
    "Cargo.toml":
      '[workspace]\nmembers=["crates/a","crates/b"]\n[workspace.package]\nversion="1.0.0"\n',
    "crates/a/Cargo.toml": '[package]\nname="a"\nversion.workspace=true\n',
    "crates/b/Cargo.toml": '[package]\nname="b"\nversion={workspace=true}\n',
    "Cargo.lock":
      'version=3\n[[package]]\nname="a"\nversion="1.0.0"\n[[package]]\nname="b"\nversion="1.0.0"\ndependencies=["a 1.0.0"]\n',
  });
  const config = {
    type: "mono",
    subprojectsDir: "crates",
    create_tag: false,
    subprojects: [
      { repo: "a", enabled: true },
      { repo: "b", enabled: true },
    ],
  } as import("../src/config.js").XEployConfig;
  applyFileEdits(root, prepareRepositoryVersions(config, root, "1.1.0").edits);
  expect(readFileSync(join(root, "Cargo.lock"), "utf8")).toContain('dependencies=["a 1.1.0"]');
  expect(readFileSync(join(root, "Cargo.lock"), "utf8").match(/version="1.1.0"/g)).toHaveLength(2);
});

test("Maven revision overrides in maven.config are the authoritative backing source", () => {
  const root = fixture({
    "pom.xml":
      "<project><version>${revision}</version><properties><revision>1.0.0</revision></properties></project>",
    ".mvn/maven.config": "-Drevision=2.0.0\n-Dother=unchanged\n",
  });
  const project = resolveProject(root);
  expect(readProjectVersion(project)).toBe("2.0.0");
  const edits = prepareProjectVersion(project, "2.1.0");
  expect(edits.map((e) => e.path)).toEqual([".mvn/maven.config"]);
  expect(edits[0]?.after).toBe("-Drevision=2.1.0\n-Dother=unchanged\n");
});

test("Cargo lock dependency references require a matching local package", () => {
  const lock =
    'version=3\n[[package]]\nname="app"\nversion="1.0.0"\ndependencies=["lib 1.0.0"]\n[[package]]\nname="lib"\nversion="1.0.0"\nsource="registry+https://example.invalid"\n';
  const root = fixture({
    "Cargo.toml": '[package]\nname="lib"\nversion="1.0.0"\n',
    "Cargo.lock": lock,
  });
  const edits = prepareProjectVersion(resolveProject(root), "1.1.0");
  expect(edits.map((e) => e.path)).toEqual(["Cargo.toml"]);
});

test("Java normalizes SNAPSHOT and RC baselines and refuses computed Gradle versions", () => {
  const root = fixture({
    "pom.xml": "<project><version>1.2.0-SNAPSHOT</version></project>",
    "app/build.gradle.kts": "version = calculateVersion()\n",
  });
  expect(readProjectVersion(resolveProject(root))).toBe("1.2.0-rc.0");
  expect(() => prepareProjectVersion(resolveProject(root, "app"), "1.2.0")).toThrow();
});

test("Flutter plist edits ignore commented keys and preserve SDK placeholders", () => {
  const plist =
    "<plist><dict><!-- <key>CFBundleVersion</key><string>999</string> --><key>CFBundleVersion</key><string>8</string><key>CFBundleShortVersionString</key><string>$(FLUTTER_BUILD_NAME)</string></dict></plist>";
  const root = fixture({ "pubspec.yaml": "version: 1.0.0+4\n", "ios/Runner/Info.plist": plist });
  applyFileEdits(root, prepareProjectVersion(resolveProject(root), "1.1.0-rc.1"));
  expect(readFileSync(join(root, "ios/Runner/Info.plist"), "utf8")).toBe(
    plist.replace("<string>8</string>", "<string>9</string>"),
  );
});

test("unknown Unity serialized settings stop with guidance before writing", () => {
  const root = fixture({
    "ProjectSettings/ProjectSettings.asset": "OtherSettings:\n  bundleVersion: 1.0.0\n",
  });
  expect(() => prepareProjectVersion(resolveProject(root), "1.1.0")).toThrow("PlayerSettings");
});

test("Godot materializes missing platform overrides in existing preset sections", () => {
  const root = fixture({
    "project.godot": '[application]\nconfig/version="1.0.0"\n',
    "export_presets.cfg":
      '[preset.0]\nplatform="iOS"\n[preset.0.options]\napplication/short_version=""\napplication/version=""\n[preset.1]\nplatform="Windows Desktop"\n[preset.1.options]\ntexture_format/bptc=true\n',
  });
  const project = resolveProject(root);
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.1"));
  const raw = readFileSync(join(root, "export_presets.cfg"), "utf8");
  expect(raw).toContain('application/file_version="1.1.0.1"');
  expect(raw).toContain('application/product_version="1.1.0.1"');
  expect(raw).toContain('application/short_version="1.1.0"');
  expect(prepareProjectVersion(project, "1.1.0-rc.1")).toEqual([]);
});

test("engine platform bindings cover Unreal Apple builds and Windows numeric fields", () => {
  const root = fixture({
    "Game.uproject": "{}",
    "Config/DefaultGame.ini":
      "[/Script/EngineSettings.GeneralProjectSettings]\nProjectVersion=1.0.0.7\n",
    "Config/DefaultEngine.ini":
      "[/Script/IOSRuntimeSettings.IOSRuntimeSettings]\nVersionInfo=1.0.0\n",
    "Build/IOS/Version.plist":
      "<plist><dict><key>CFBundleVersion</key><string>8.3</string></dict></plist>",
  });
  const project = resolveProject(root, ".", {
    platform_fields: [
      {
        file: "Build/IOS/Version.plist",
        format: "plist",
        key: "CFBundleVersion",
        kind: "apple-counter",
      },
    ],
  });
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.1"));
  expect(readFileSync(join(root, "Config/DefaultEngine.ini"), "utf8")).toContain(
    "VersionInfo=1.1.0",
  );
  expect(readFileSync(join(root, "Build/IOS/Version.plist"), "utf8")).toContain(
    "<string>8.4</string>",
  );
  expect(readFileSync(join(root, "Config/DefaultGame.ini"), "utf8")).toContain(
    "ProjectVersion=1.1.0.8",
  );
});

test("Unity VisionOS and standalone builds preserve offsets and CRLF during promotion", () => {
  const raw =
    "PlayerSettings:\r\n  bundleVersion: 1.0.0\r\n  buildNumber:\r\n    Standalone: 7\r\n    VisionOS: 4.2\r\n  unrelated: keep\r\n";
  const root = fixture({ "ProjectSettings/ProjectSettings.asset": raw });
  const project = resolveProject(root);
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.1"));
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0"));
  expect(readFileSync(join(root, "ProjectSettings/ProjectSettings.asset"), "utf8")).toBe(
    raw
      .replace("1.0.0", "1.1.0")
      .replace("Standalone: 7", "Standalone: 9")
      .replace("VisionOS: 4.2", "VisionOS: 4.4"),
  );
});

test("Unreal Android architecture offsets cannot overflow effective store versions", () => {
  const root = fixture({
    "Game.uproject": "{}",
    "Config/DefaultGame.ini":
      "[/Script/EngineSettings.GeneralProjectSettings]\nProjectVersion=1.0.0\n",
    "Config/DefaultEngine.ini":
      "[/Script/AndroidRuntimeSettings.AndroidRuntimeSettings]\nStoreVersion=2147483646\nStoreVersionOffsetArm64=10\n",
  });
  expect(() => prepareProjectVersion(resolveProject(root), "1.1.0")).toThrow("offset");
});

test("Maven compound CI versions can split revision and changelist across backing files", () => {
  const root = fixture({
    "pom.xml":
      "<project><version>${revision}${changelist}</version><properties><revision>1.0.0</revision><changelist>-SNAPSHOT</changelist></properties></project>",
    ".mvn/maven.config": "-Drevision=2.0.0\n",
  });
  const project = resolveProject(root);
  expect(readProjectVersion(project)).toBe("2.0.0-rc.0");
  applyFileEdits(root, prepareProjectVersion(project, "2.1.0-rc.2"));
  expect(readFileSync(join(root, ".mvn/maven.config"), "utf8")).toBe("-Drevision=2.1.0\n");
  expect(readFileSync(join(root, "pom.xml"), "utf8")).toContain("<changelist>-rc.2</changelist>");
  expect(readProjectVersion(project)).toBe("2.1.0-rc.2");
});

test("subset releases detect shared platform declarations but allow separate fields in one file", async () => {
  const { prepareRepositoryVersions } = await import("../src/project-release.js");
  const root = fixture({
    VERSION: "1.0.0\n",
    "apps/a/VERSION": "1.0.0\n",
    "apps/b/VERSION": "1.0.0\n",
    "build.json": '{"shared":7,"other":9}',
  });
  const field = {
    file: "../../build.json",
    format: "json" as const,
    key: "shared",
    kind: "counter" as const,
  };
  const config = {
    type: "mono",
    subprojectsDir: "apps",
    create_tag: false,
    subprojects: [
      { repo: "a", enabled: true, project: { platform_fields: [field] } },
      { repo: "b", enabled: true, project: { platform_fields: [field] } },
    ],
  } as import("../src/config.js").XEployConfig;
  expect(() =>
    prepareRepositoryVersions(config, root, "1.1.0", { includeUmbrella: false, repos: ["a"] }),
  ).toThrow("unselected");
  config.subprojects![1]!.project!.platform_fields![0] = { ...field, key: "other" };
  const edits = prepareRepositoryVersions(config, root, "1.1.0", {
    includeUmbrella: false,
    repos: ["a"],
  }).edits;
  expect(edits.find((edit) => edit.path === "build.json")?.after).toBe('{"shared":8,"other":9}');
});

test("empty XML version elements fail with literal-source guidance instead of inserting duplicates", () => {
  const root = fixture({
    "App.csproj":
      "<Project><PropertyGroup><VersionPrefix>1.0.0</VersionPrefix><VersionSuffix/></PropertyGroup></Project>",
  });
  expect(() => prepareProjectVersion(resolveProject(root), "1.1.0-rc.1")).toThrow("literal");
});

for (const [label, files] of [
  [
    "Hatch",
    {
      "pyproject.toml":
        '[project]\ndynamic=["version"]\n[tool.hatch.version]\npath="src/api/__about__.py"\n',
      "src/api/__about__.py": '__version__ = "1.0.0"\n',
    },
  ],
  [
    "VB.NET",
    { "App.vbproj": "<Project><PropertyGroup><Version>1.0.0</Version></PropertyGroup></Project>" },
  ],
  [
    "Gradle Kotlin property",
    {
      "build.gradle.kts": 'version = property("releaseVersion") as String\n',
      "gradle.properties": "releaseVersion=1.0.0\n",
    },
  ],
] as const)
  test(`${label} static provider round trips canonical RC versions`, () => {
    const root = fixture(files);
    const project = resolveProject(root);
    expect(readProjectVersion(project)).toBe("1.0.0");
    applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.2"));
    expect(readProjectVersion(project)).toBe("1.1.0-rc.2");
  });

test("missing Flutter versions use VERSION while malformed or duplicate values stop", () => {
  const root = fixture({ "pubspec.yaml": "name: mobile\n" });
  expect(resolveProject(root).versionFile).toBe("VERSION");
  for (const raw of [
    "version: invalid\n",
    "version: 1.0.0\nversion: 2.0.0\n",
    "version: 1.0.0+abc\n",
  ]) {
    writeFileSync(join(root, "pubspec.yaml"), raw);
    expect(() => prepareProjectVersion(resolveProject(root), "1.1.0")).toThrow();
  }
});

test("explicit YAML, XML, and INI bindings preserve comments and advance native values", () => {
  const root = fixture({
    VERSION: "1.0.0\n",
    "settings.yml": 'name: keep\nversion: "1.0.0" # comment\n',
    "settings.xml": "<Config><FileVersion>1.0.0.4</FileVersion></Config>",
    "build.ini": "[build]\ncount=7 ; comment\n",
  });
  const project = resolveProject(root, ".", {
    platform_fields: [
      { file: "settings.yml", format: "yaml", key: "version", section: "", kind: "base" },
      { file: "settings.xml", format: "xml", key: "Config/FileVersion", kind: "numeric4" },
      { file: "build.ini", format: "ini", key: "count", section: "build", kind: "counter" },
    ],
  });
  applyFileEdits(root, prepareProjectVersion(project, "1.1.0-rc.1"));
  expect(readFileSync(join(root, "settings.yml"), "utf8")).toBe(
    'name: keep\nversion: "1.1.0" # comment\n',
  );
  expect(readFileSync(join(root, "settings.xml"), "utf8")).toContain("1.1.0.5");
  expect(readFileSync(join(root, "build.ini"), "utf8")).toBe("[build]\ncount=8 ; comment\n");
  expect(prepareProjectVersion(project, "1.1.0-rc.1")).toEqual([]);
});

test(".NET platform properties inherit shared defaults while retaining local overrides", () => {
  const root = fixture({
    "Directory.Build.props":
      "<Project><PropertyGroup><FileVersion>1.0.0.4</FileVersion><AssemblyVersion>1.0.0.0</AssemblyVersion></PropertyGroup></Project>",
    "apps/api/App.csproj":
      "<Project><PropertyGroup><Version>1.0.0</Version><AssemblyVersion>1.0.0.9</AssemblyVersion></PropertyGroup></Project>",
  });
  const edits = prepareProjectVersion(resolveProject(root, "apps/api"), "1.1.0-rc.1");
  expect(edits.find((edit) => edit.path === "Directory.Build.props")?.after).toBe(
    "<Project><PropertyGroup><FileVersion>1.1.0.5</FileVersion><AssemblyVersion>1.0.0.0</AssemblyVersion></PropertyGroup></Project>",
  );
});

test("canonical identities cannot conflict when aliases produce identical native values", async () => {
  const { mergeProjectEdits } = await import("../src/project-state.js");
  const edits = [1, 2].map((rc) => ({
    path: ".xeploy-state.json",
    before: null,
    after: JSON.stringify({
      schema: 1,
      projects: {
        ".": {
          version: `1.1.0-rc.${rc}`,
          source: "ProjectSettings/ProjectSettings.asset",
          nativeVersion: "1.1.0",
        },
      },
    }),
  }));
  expect(() => mergeProjectEdits(edits)).toThrow("Conflicting");
});

test("unknown MSBuild imports cannot silently override the planned literal version", () => {
  const root = fixture({
    "App.csproj":
      '<Project><PropertyGroup><Version>1.0.0</Version></PropertyGroup><Import Project="custom.props"/></Project>',
  });
  expect(() => prepareProjectVersion(resolveProject(root), "1.1.0")).toThrow("import");
});
