import * as fs from "node:fs";
import * as path from "node:path";
import { projectCandidates } from "./discover.js";
import { run } from "./git.js";
import { goModuleTag } from "./go-project.js";
import {
  dotnetSource,
  javaSource,
  loadSource,
  pythonSource,
  rustLockEdits,
  rustSource,
  sourceLine,
} from "./manifest-sources.js";
import type { ManifestSource } from "./manifest-sources.js";
import { jsonSpans, lineSpans, oneSpan, replaceSpans } from "./project-edits.js";
import type { ValueSpan } from "./project-edits.js";
import type { FileEdit, ProjectConfig, ProjectDescriptor } from "./project-model.js";
import {
  AmbiguousProjectError,
  ProjectSourceError,
  canonicalVersion,
  projectPath,
  validateProjectConfig,
} from "./project-model.js";
import {
  configuredPlatformFields,
  dotnetPlatformFields,
  flutterPlatformFields,
  godotPlatformFields,
  platformValue,
  unityPlatformFields,
  unrealPlatformFields,
} from "./project-platforms.js";
import { readReleaseState, releaseStateEdit } from "./project-state.js";
import { compareSemVer, formatSemVer, parseSemVer } from "./semver.js";
import { assertReleaseVersion } from "./validate.js";

export function resolveProject(
  root: string,
  inputDirectory = ".",
  config: ProjectConfig = {},
): ProjectDescriptor {
  validateProjectConfig(config);
  const absolute = projectPath(root, inputDirectory);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new ProjectSourceError(`Project directory not found: ${inputDirectory}`);
  }
  const directory = path.relative(path.resolve(root), absolute) || ".";
  let candidates = projectCandidates(absolute);
  if (config.ecosystem)
    candidates = candidates.filter((candidate) => candidate.ecosystem === config.ecosystem);
  if (config.version_file)
    candidates = candidates.filter((candidate) => candidate.file === config.version_file);
  if (candidates.length > 1) throw new AmbiguousProjectError(candidates, directory);
  const candidate = candidates[0];
  const ecosystem = config.ecosystem ?? candidate?.ecosystem ?? "generic";
  const versionFile =
    config.version_file ?? (ecosystem === "go" ? "VERSION" : candidate?.file) ?? "VERSION";
  projectPath(root, path.join(directory, versionFile));
  const descriptor: ProjectDescriptor = {
    id: directory.replaceAll(path.sep, "/"),
    root: path.resolve(root),
    directory,
    ecosystem,
    versionFile,
    initialVersion: config.initial_version,
    platformFields: config.platform_fields,
  };
  if (!config.version_file && ecosystem !== "go" && ecosystem !== "generic") {
    const raw = fs.existsSync(path.join(absolute, versionFile))
      ? fs.readFileSync(projectPath(root, path.join(directory, versionFile)), "utf8")
      : null;
    if (
      ecosystem === "python" &&
      raw &&
      /\bdynamic\s*=\s*\[[\s\S]*?["']version["']/.test(raw) &&
      (/^\[tool\.setuptools_scm\]/m.test(raw) ||
        sourceLine({ file: versionFile, raw }, "source", "tool.hatch.version").span?.value ===
          "vcs")
    ) {
      if (
        directory !== "." ||
        /\b(?:tag_regex|tag-pattern|version_scheme|local_scheme|root|relative_to)\s*=|^\[tool\.(?:setuptools_scm\.tag|hatch\.version\.raw-options)\]/m.test(
          raw,
        )
      )
        throw new ProjectSourceError(
          "Configure a literal version source for nested or customized Python SCM providers",
        );
      descriptor.gitDerived = true;
      descriptor.versionFile = "VERSION";
    }
    const absent =
      ecosystem === "javascript"
        ? raw !== null && !Object.hasOwn(JSON.parse(raw), "version")
        : ecosystem === "flutter"
          ? raw !== null && lineSpans(raw, "version", "", ":").length === 0
          : ecosystem === "unreal" && !versionFile.endsWith(".uplugin")
            ? raw === null ||
              lineSpans(raw, "ProjectVersion", "/Script/EngineSettings.GeneralProjectSettings")
                .length === 0
            : ecosystem === "godot"
              ? raw !== null &&
                lineSpans(
                  raw,
                  versionFile.endsWith("plugin.cfg") ? "version" : "config/version",
                  versionFile.endsWith("plugin.cfg") ? "plugin" : "application",
                ).length === 0
              : ecosystem === "dotnet"
                ? raw !== null &&
                  !/<Import\b/.test(raw) &&
                  !dotnetSource(descriptor, { file: path.join(directory, versionFile), raw }).span
                : ecosystem === "rust"
                  ? raw !== null &&
                    !rustSource(descriptor, { file: path.join(directory, versionFile), raw }).span
                  : ecosystem === "python"
                    ? raw !== null &&
                      !/\b(?:dynamic|version)\s*=|setuptools_scm|poetry-dynamic-versioning/.test(
                        raw,
                      ) &&
                      !pythonSource(descriptor, { file: path.join(directory, versionFile), raw })
                        .span
                    : ecosystem === "java"
                      ? raw !== null &&
                        !javaSource(descriptor, { file: path.join(directory, versionFile), raw })
                          .span &&
                        !/\bversion\b|<parent\b/.test(raw)
                      : false;
    if (absent) descriptor.versionFile = "VERSION";
  }
  return descriptor;
}

type Source = ManifestSource;

function primarySource(project: ProjectDescriptor): Source {
  const file = path.join(project.directory, project.versionFile);
  const { raw } = loadSource(project, file);
  if (project.ecosystem === "generic" || project.versionFile === "VERSION") {
    if (raw === null) return { file, raw };
    const value = raw.trim();
    canonicalVersion(value);
    const start = raw.indexOf(value);
    return { file, raw, span: { start, end: start + value.length, value } };
  }
  if (raw === null) throw new ProjectSourceError(`Version source not found: ${file}`);
  let span: ValueSpan | undefined;
  if (project.ecosystem === "javascript") span = jsonSpans(raw).get("version");
  else if (project.ecosystem === "unity")
    span = project.versionFile.endsWith("package.json")
      ? jsonSpans(raw).get("version")
      : oneSpan(lineSpans(raw, "bundleVersion", undefined, ":"), file);
  else if (project.ecosystem === "godot")
    span = oneSpan(
      lineSpans(
        raw,
        project.versionFile.endsWith("plugin.cfg") ? "version" : "config/version",
        project.versionFile.endsWith("plugin.cfg") ? "plugin" : "application",
      ),
      file,
    );
  else if (project.ecosystem === "unreal")
    span = project.versionFile.endsWith(".uplugin")
      ? jsonSpans(raw).get("VersionName")
      : oneSpan(
          lineSpans(raw, "ProjectVersion", "/Script/EngineSettings.GeneralProjectSettings"),
          file,
        );
  else if (project.ecosystem === "flutter")
    span = oneSpan(lineSpans(raw, "version", "", ":"), file);
  else if (["python", "dotnet", "rust", "java"].includes(project.ecosystem)) {
    const adapter =
      project.ecosystem === "python"
        ? pythonSource
        : project.ecosystem === "rust"
          ? rustSource
          : project.ecosystem === "java"
            ? javaSource
            : dotnetSource;
    const source = adapter(project, { file, raw });
    if (!source.span)
      throw new ProjectSourceError(
        `No static version in ${file}; configure project.version_file explicitly`,
      );
    return source;
  } else throw new ProjectSourceError(`Version adapter not implemented: ${project.ecosystem}`);
  if (!span)
    throw new ProjectSourceError(
      `No static version in ${file}; configure project.version_file explicitly`,
    );
  return {
    file,
    raw,
    span,
    numericPrimary:
      project.ecosystem === "unreal" && /^\d+\.\d+\.\d+\.\d+$/.test(span.value)
        ? "numeric4"
        : undefined,
  };
}

export function readProjectVersion(project: ProjectDescriptor): string | null {
  const source = primarySource(project);
  const state = readReleaseState(project.root, project.snapshot).projects[project.id];
  if (
    state &&
    state.source === source.file &&
    state.nativeVersion === (source.nativeVersion ?? source.span?.value)
  )
    return state.version;
  if (project.gitDerived && !source.span) {
    const tags = run("git", ["tag", "--merged", "HEAD"], project.root)
      .split("\n")
      .map(parseSemVer)
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((a, b) => compareSemVer(b, a));
    if (tags[0]) return formatSemVer(tags[0]);
  }
  return source.span
    ? canonicalVersion(source.nativeVersion ?? source.span.value, project.ecosystem)
    : (project.initialVersion ?? null);
}

export function projectVersionSource(project: ProjectDescriptor): string {
  return primarySource(project).file;
}

/** Literal declaration ownership, including platform fields, for subset safety. */
export function projectVersionBindings(project: ProjectDescriptor): ManifestSource[] {
  const source = primarySource(project);
  return [
    source,
    ...(source.suffix ? [{ ...source, span: source.suffix }] : []),
    ...(source.suffixSource ? [source.suffixSource] : []),
    ...(source.related ?? []),
    ...configuredPlatformFields(project),
    ...(project.ecosystem === "dotnet"
      ? dotnetPlatformFields(project, source)
      : project.ecosystem === "godot" && project.versionFile.endsWith("project.godot")
        ? godotPlatformFields(project)
        : project.ecosystem === "unreal"
          ? unrealPlatformFields(project, source)
          : project.ecosystem === "flutter"
            ? flutterPlatformFields(project)
            : project.ecosystem === "unity" && project.versionFile.endsWith(".asset")
              ? unityPlatformFields(project, source)
              : []),
  ];
}

export function prepareProjectVersion(
  project: ProjectDescriptor,
  target: string,
  increments = 1,
): FileEdit[] {
  assertReleaseVersion(target);
  if (project.ecosystem === "go") goModuleTag(project, target);
  const source = primarySource(project);
  const current = readProjectVersion(project);
  let value = target;
  const unityGame = project.ecosystem === "unity" && project.versionFile.endsWith(".asset");
  if (unityGame && !/^PlayerSettings:\s*$/m.test(source.raw ?? ""))
    throw new ProjectSourceError(
      `Unsupported Unity PlayerSettings layout in ${source.file}; configure a known serialized source`,
    );
  if (unityGame) value = target.replace(/-rc\.\d+$/, "");
  if (source.numericPrimary && source.span)
    value = platformValue(
      { ...source, span: source.span, kind: source.numericPrimary },
      target,
      current !== target ? increments : 0,
    );
  if (project.ecosystem === "python" && project.versionFile !== "VERSION")
    value = target.replace(/-rc\.(\d+)$/, "rc$1");
  if (project.ecosystem === "flutter" && project.versionFile !== "VERSION") {
    const previous = source.span?.value ?? "";
    const count = Number(previous.match(/\+(\d+)$/)?.[1] ?? "0");
    const next = count + (current === target ? 0 : increments);
    if (!Number.isSafeInteger(next))
      throw new ProjectSourceError(
        `Flutter build number exceeds safe integer limit in ${source.file}`,
      );
    const nativeTargets = ["android", "ios", "macos", "windows"].filter((platform) =>
      fs.existsSync(path.join(project.root, project.directory, platform)),
    );
    const numericName = nativeTargets.some((platform) => platform !== "android");
    const limit = nativeTargets.includes("windows")
      ? 65535
      : nativeTargets.includes("android") || nativeTargets.length === 0
        ? 2100000000
        : Number.MAX_SAFE_INTEGER;
    if (
      next > limit ||
      (nativeTargets.includes("windows") &&
        target
          .replace(/-rc\.\d+$/, "")
          .split(".")
          .some((component) => Number(component) > 65535))
    )
      throw new ProjectSourceError(
        `Flutter version exceeds a native platform limit in ${source.file}`,
      );
    value = `${numericName ? target.replace(/-rc\.\d+$/, "") : target}+${next}`;
  }
  const values = source.span ? [{ span: source.span, value }] : [];
  for (const related of source.related ?? []) {
    if (related.file === source.file && related.span) values.push({ span: related.span, value });
  }
  const extraFields = [
    ...(source.suffixSource?.span
      ? [
          {
            ...source.suffixSource,
            span: source.suffixSource.span,
            kind: "suffix" as const,
            suffixIncludesDash: source.suffixIncludesDash,
            insertion: undefined,
          },
        ]
      : []),
    ...(source.related ?? [])
      .filter((related) => related.file !== source.file && related.span)
      .map((related) => ({
        ...related,
        span: related.span as ValueSpan,
        kind: "release" as const,
        insertion: undefined,
      })),
    ...configuredPlatformFields(project),
    ...(project.ecosystem === "dotnet"
      ? dotnetPlatformFields(project, source)
      : project.ecosystem === "godot" && project.versionFile.endsWith("project.godot")
        ? godotPlatformFields(project)
        : project.ecosystem === "unreal" && !project.versionFile.endsWith(".uplugin")
          ? unrealPlatformFields(project, source)
          : project.ecosystem === "flutter"
            ? flutterPlatformFields(project)
            : []),
  ].filter(
    (field, index, fields) =>
      field.insertion ||
      fields.findIndex(
        (other) =>
          other.file === field.file &&
          other.span.start === field.span.start &&
          other.span.end === field.span.end &&
          !field.insertion,
      ) === index,
  );
  for (const field of extraFields.filter((field) => field.file === source.file))
    values.push({
      span: field.span,
      value: platformValue(field, target, current !== target ? increments : 0),
    });
  if (unityGame) {
    for (const field of unityPlatformFields(project, source)) {
      values.push({
        span: field.span,
        value: platformValue(field, target, current !== target ? increments : 0),
      });
    }
  }
  if (project.ecosystem === "unreal" && project.versionFile.endsWith(".uplugin")) {
    for (const field of unrealPlatformFields(project, source))
      values.push({
        span: field.span,
        value: platformValue(field, target, current !== target ? increments : 0),
      });
  }
  if (source.prefix && source.span) {
    values[0] = { span: source.span, value: target.replace(/-rc\.\d+$/, "") };
    const suffix = target.match(/-rc\.\d+$/)?.[0].slice(1) ?? "";
    if (source.suffix)
      values.push({
        span: source.suffix,
        value: suffix && source.suffixIncludesDash ? `-${suffix}` : suffix,
      });
    else if (suffix && source.raw && !source.suffixSource) {
      const close = source.raw.indexOf("</VersionPrefix>", source.span.end);
      if (close < 0)
        throw new ProjectSourceError(`Missing VersionPrefix closing element in ${source.file}`);
      const start = close + "</VersionPrefix>".length;
      const indent = source.raw
        .slice(0, source.span.start)
        .match(/\r?\n([ \t]*)<VersionPrefix>\s*$/)?.[1];
      values.push({
        span: { start, end: start, value: "" },
        value: `${indent !== undefined ? `${source.raw.includes("\r\n") ? "\r\n" : "\n"}${indent}` : ""}<VersionSuffix>${suffix}</VersionSuffix>`,
      });
    }
  }
  const after =
    source.raw !== null && source.span ? replaceSpans(source.raw, values) : `${value}\n`;
  const edits: FileEdit[] =
    after === source.raw
      ? []
      : [
          {
            path: source.file,
            before: source.raw,
            after,
            changes: source.span
              ? values.map(({ span, value }) => ({ ...span, replacement: value }))
              : undefined,
          },
        ];
  if (
    (project.ecosystem === "flutter" && project.versionFile !== "VERSION") ||
    unityGame ||
    source.numericPrimary
  ) {
    const counters = Object.fromEntries(
      values.slice(1).map((field, index) => [`${source.file}:${index}`, field.value]),
    );
    if (project.ecosystem === "flutter") counters.build = value.match(/\+(\d+)$/)?.[1] ?? "0";
    const state = releaseStateEdit(project, {
      version: target,
      source: source.file,
      nativeVersion: value,
      counters,
    });
    if (state) edits.push(state);
  }
  if (extraFields.length) {
    const fields = extraFields.filter((field) => field.file !== source.file);
    const files = new Set(fields.map((field) => field.file));
    for (const file of files) {
      const group = fields.filter((field) => field.file === file);
      const raw = group[0]?.raw ?? "";
      const next = replaceSpans(
        raw,
        group.map((field) => ({
          span: field.span,
          value: platformValue(field, target, current !== target ? increments : 0),
        })),
      );
      if (next !== raw)
        edits.push({
          path: file,
          before: raw,
          after: next,
          changes: group.map((field) => ({
            ...field.span,
            replacement: platformValue(field, target, current !== target ? increments : 0),
          })),
        });
    }
  }
  if (project.ecosystem === "rust") edits.push(...rustLockEdits(project, current, target));
  return edits;
}
