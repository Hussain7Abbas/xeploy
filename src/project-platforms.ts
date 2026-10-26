import * as path from "node:path";
import { loadSource } from "./manifest-sources.js";
import type { ManifestSource } from "./manifest-sources.js";
import { jsonSpans, lineSpans, oneSpan, plistSpans, xmlSpans } from "./project-edits.js";
import type { ValueSpan } from "./project-edits.js";
import type { ProjectDescriptor } from "./project-model.js";
import { ProjectSourceError } from "./project-model.js";

export interface PlatformField extends ManifestSource {
  span: ValueSpan;
  kind: "release" | "base" | "counter" | "apple-counter" | "numeric4" | "assembly" | "suffix";
  limit?: number;
  insertion?: { prefix: string; suffix: string };
}

export function configuredPlatformFields(project: ProjectDescriptor): PlatformField[] {
  return (project.platformFields ?? []).map((field) => {
    const source = loadSource(project, path.join(project.directory, field.file));
    if (source.raw === null)
      throw new ProjectSourceError(`Platform source not found: ${source.file}`);
    const raw = source.raw;
    const span =
      field.format === "json"
        ? jsonSpans(raw).get(field.key)
        : field.format === "xml"
          ? oneSpan(xmlSpans(raw, field.key), source.file)
          : field.format === "plist"
            ? oneSpan(plistSpans(raw, field.key), source.file)
            : oneSpan(
                lineSpans(raw, field.key, field.section, field.format === "yaml" ? ":" : "="),
                source.file,
              );
    if (!span)
      throw new ProjectSourceError(`Platform field ${field.key} not found in ${source.file}`);
    return { ...source, span, kind: field.kind, limit: field.limit };
  });
}

export function flutterPlatformFields(project: ProjectDescriptor): PlatformField[] {
  const fields: PlatformField[] = [];
  for (const relative of ["ios/Runner/Info.plist", "macos/Runner/Info.plist"]) {
    const source = loadSource(project, path.join(project.directory, relative));
    for (const [key, kind] of [
      ["CFBundleShortVersionString", "base"],
      ["CFBundleVersion", "apple-counter"],
    ] as const) {
      const span = oneSpan(plistSpans(source.raw ?? "", key), `${source.file}: ${key}`);
      // Normal Flutter projects inherit pubspec values through these placeholders.
      if (span && !/^\$\((?:FLUTTER_BUILD_NAME|FLUTTER_BUILD_NUMBER)\)$/.test(span.value))
        fields.push({ ...source, span, kind });
    }
  }
  return fields;
}

export function dotnetPlatformFields(
  project: ProjectDescriptor,
  primary: ManifestSource,
): PlatformField[] {
  const original = path.join(project.directory, project.versionFile);
  const files = [...new Set([original, primary.file])];
  if (/\.(?:csproj|fsproj|vbproj)$/.test(original)) {
    let directory = project.directory;
    while (!directory.startsWith("..")) {
      const props = loadSource(project, path.join(directory, "Directory.Build.props"));
      if (props.raw !== null) {
        if (!files.includes(props.file)) files.push(props.file);
        break;
      }
      if (directory === ".") break;
      directory = path.dirname(directory);
    }
  }
  const seen = new Set<string>();
  const fields: PlatformField[] = [];
  const specs: [string, PlatformField["kind"]][] = [
    ["Version", "release"],
    ["PackageVersion", "release"],
    ["VersionPrefix", "base"],
    ["VersionSuffix", "suffix"],
    ["InformationalVersion", "release"],
    ["FileVersion", "numeric4"],
    ["AssemblyVersion", "assembly"],
    ["ApplicationDisplayVersion", "base"],
    ["ApplicationVersion", "counter"],
  ];
  for (const file of files) {
    if (!/\.(?:props|csproj|fsproj|vbproj)$/i.test(file)) continue;
    const source = loadSource(project, file);
    for (const [key, kind] of specs) {
      const span = oneSpan(
        xmlSpans(source.raw ?? "", `Project/PropertyGroup/${key}`),
        `${file}: ${key}`,
      );
      if (span && seen.has(key)) continue;
      if (span) seen.add(key);
      if (
        span &&
        !span.value.includes("$(") &&
        !(
          primary.file === file && [primary.span?.start, primary.suffix?.start].includes(span.start)
        )
      )
        fields.push({ ...source, span, kind });
    }
  }
  return fields;
}

export function unityPlatformFields(
  project: ProjectDescriptor,
  source: ManifestSource,
): PlatformField[] {
  const fields: PlatformField[] = [];
  const raw = source.raw ?? "";
  const add = (spans: ValueSpan[], kind: PlatformField["kind"], limit?: number) => {
    const span = oneSpan(spans, source.file);
    if (span) fields.push({ ...source, span, kind, limit });
  };
  add(lineSpans(raw, "AndroidBundleVersionCode", undefined, ":"), "counter", 2100000000);
  const block = raw.match(
    /^([ \t]*)buildNumber:[ \t]*\r?\n((?:(?:\1[ \t]+[^\r\n]*|[ \t]*)\r?\n)*)/m,
  );
  if (block?.[2]) {
    const start = (block.index ?? 0) + block[0].length - block[2].length;
    for (const name of ["Standalone", "iPhone", "tvOS", "VisionOS"]) {
      add(
        lineSpans(block[2], name, undefined, ":").map((span) => ({
          ...span,
          start: span.start + start,
          end: span.end + start,
        })),
        name === "Standalone" ? "counter" : "apple-counter",
      );
    }
  }
  return fields;
}

export function godotPlatformFields(project: ProjectDescriptor): PlatformField[] {
  const source = loadSource(project, path.join(project.directory, "export_presets.cfg"));
  const raw = source.raw ?? "";
  const fields: PlatformField[] = [];
  const presets = [...raw.matchAll(/^\[preset\.(\d+)\]\s*\r?$/gm)].map((match) => match[1]);
  for (const preset of presets) {
    const platform = oneSpan(lineSpans(raw, "platform", `preset.${preset}`), source.file)?.value;
    const specs: [string, PlatformField["kind"], number?][] =
      platform === "Android"
        ? [
            ["version/name", "release"],
            ["version/code", "counter", 2100000000],
          ]
        : platform === "iOS" || platform === "macOS"
          ? [
              ["application/short_version", "base"],
              ["application/version", "apple-counter"],
            ]
          : platform === "Windows Desktop"
            ? [
                ["application/file_version", "numeric4"],
                ["application/product_version", "numeric4"],
              ]
            : [];
    for (const [key, kind, limit] of specs) {
      const span = oneSpan(
        lineSpans(raw, key, `preset.${preset}.options`),
        `${source.file}: ${key}`,
      );
      if (span) fields.push({ ...source, span, kind, limit });
      else {
        const header = `[preset.${preset}.options]`;
        const start = raw.indexOf(header);
        if (start < 0)
          throw new ProjectSourceError(
            `Missing ${header} in ${source.file}; add an export options section`,
          );
        const following = raw.slice(start + header.length).search(/^\[/m);
        const end = following < 0 ? raw.length : start + header.length + following;
        const eol = raw.includes("\r\n") ? "\r\n" : "\n";
        fields.push({
          ...source,
          span: { start: end, end, value: "" },
          kind,
          limit,
          insertion: {
            prefix: `${raw.slice(0, end).endsWith("\n") ? "" : eol}${key}="`,
            suffix: `"${eol}`,
          },
        });
      }
    }
  }
  return fields;
}

export function unrealPlatformFields(
  project: ProjectDescriptor,
  primary: ManifestSource,
): PlatformField[] {
  if (project.versionFile.endsWith(".uplugin")) {
    const span = jsonSpans(primary.raw ?? "{}").get("Version");
    return span ? [{ ...primary, span, kind: "counter" }] : [];
  }
  const source = loadSource(project, path.join(project.directory, "Config/DefaultEngine.ini"));
  const raw = source.raw ?? "";
  const fields: PlatformField[] = [];
  const specs: [string, string, PlatformField["kind"]][] = [
    ["/Script/AndroidRuntimeSettings.AndroidRuntimeSettings", "StoreVersion", "counter"],
    ["/Script/AndroidRuntimeSettings.AndroidRuntimeSettings", "VersionDisplayName", "release"],
    ["/Script/IOSRuntimeSettings.IOSRuntimeSettings", "VersionInfo", "base"],
  ];
  for (const [section, key, kind] of specs) {
    const span = oneSpan(lineSpans(raw, key, section), `${source.file}: ${key}`);
    if (span) {
      let limit: number | undefined;
      if (key === "StoreVersion") {
        const offsets = ["ArmV7", "Arm64", "X8664"].map(
          (arch) =>
            oneSpan(lineSpans(raw, `StoreVersionOffset${arch}`, section), source.file)?.value ??
            "0",
        );
        if (
          offsets.some((offset) => !/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset)))
        )
          throw new ProjectSourceError(`Invalid Android store-version offset in ${source.file}`);
        limit = 2100000000 - Math.max(...offsets.map(Number));
        if (Number(span.value) > limit)
          throw new ProjectSourceError(
            `Android store-version offset exceeds platform bounds in ${source.file}`,
          );
      }
      fields.push({ ...source, span, kind, limit });
    }
  }
  return fields;
}

export function platformValue(
  field: PlatformField,
  target: string,
  increment: boolean | number,
): string {
  if (field.insertion)
    return (
      field.insertion.prefix +
      platformValue({ ...field, insertion: undefined }, target, increment) +
      field.insertion.suffix
    );
  const base = target.replace(/-rc\.\d+$/, "");
  if (field.kind === "release") return target;
  if (field.kind === "base") return base;
  if (field.kind === "suffix")
    return (target.match(/-rc\.(\d+)$/)?.[0] ?? "").slice(field.suffixIncludesDash ? 0 : 1);
  if (field.kind === "assembly") {
    const value = `${base}.0`;
    if (value.split(".").some((part) => Number(part) > 65535))
      throw new ProjectSourceError(`Assembly version exceeds platform limit in ${field.file}`);
    return value;
  }
  if (field.kind === "numeric4") {
    const match = field.span.value.match(/^\d+\.\d+\.\d+(?:\.(\d+))?$/);
    const revision = field.span.value ? (match ? (match[1] ?? "0") : undefined) : "0";
    if (revision === undefined)
      throw new ProjectSourceError(`Invalid numeric version in ${field.file}`);
    const next = Number(revision) + Number(increment);
    const result = `${base}.${next}`;
    if (
      result.split(".").some((part) => !Number.isSafeInteger(Number(part)) || Number(part) > 65535)
    ) {
      throw new ProjectSourceError(`Numeric version exceeds platform bounds in ${field.file}`);
    }
    return result;
  }
  const previous = field.span.value || "0";
  const pattern = field.kind === "apple-counter" ? /^\d+(?:\.\d+){0,2}$/ : /^\d+$/;
  if (!pattern.test(previous))
    throw new ProjectSourceError(`Invalid build counter in ${field.file}`);
  const parts = previous.split(".").map(Number);
  const last = parts.length - 1;
  parts[last] = (parts[last] ?? 0) + Number(increment);
  const limit =
    field.limit ?? (field.kind === "apple-counter" ? Number.MAX_SAFE_INTEGER : 2147483647);
  if (parts.some((part) => !Number.isSafeInteger(part) || part > limit))
    throw new ProjectSourceError(`Build counter exceeds platform limit in ${field.file}`);
  return parts.join(".");
}
