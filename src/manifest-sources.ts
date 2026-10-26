import * as fs from "node:fs";
import * as path from "node:path";
import { lineSpans, oneSpan, replaceSpans, xmlSpans } from "./project-edits.js";
import type { ValueSpan } from "./project-edits.js";
import type { FileEdit, ProjectDescriptor } from "./project-model.js";
import { ProjectSourceError, projectPath } from "./project-model.js";

export interface ManifestSource {
  file: string;
  raw: string | null;
  span?: ValueSpan;
  suffix?: ValueSpan;
  suffixSource?: ManifestSource;
  prefix?: boolean;
  suffixIncludesDash?: boolean;
  nativeVersion?: string;
  numericPrimary?: "base" | "numeric4";
  related?: ManifestSource[];
}

export function dotnetSource(project: ProjectDescriptor, original: ManifestSource): ManifestSource {
  const sources = [original];
  if (/\.(?:csproj|fsproj|vbproj)$/.test(original.file)) {
    let directory = path.dirname(original.file);
    while (!directory.startsWith("..")) {
      const props = loadSource(project, path.join(directory, "Directory.Build.props"));
      if (props.raw !== null) {
        sources.push(props);
        break;
      }
      if (directory === ".") break;
      directory = path.dirname(directory);
    }
  }
  for (const source of sources)
    if (/<Import\b/.test((source.raw ?? "").replace(/<!--[\s\S]*?-->/g, "")))
      throw new ProjectSourceError(
        `Unresolved MSBuild imports in ${source.file}; configure a concrete literal backing file explicitly`,
      );
  // MSBuild's Version takes precedence over Prefix, even when inherited.
  for (const key of ["Version", "PackageVersion", "VersionPrefix", "ApplicationDisplayVersion"]) {
    for (const source of sources) {
      const span = oneSpan(
        xmlSpans(source.raw ?? "", `Project/PropertyGroup/${key}`),
        `${source.file}: ${key}`,
      );
      if (!span) continue;
      const reference = span.value.match(/^\$\(([A-Za-z_][\w.-]*)\)$/)?.[1];
      if (reference) {
        if (key === "VersionPrefix")
          throw new ProjectSourceError(`Configure a literal VersionPrefix in ${source.file}`);
        return {
          ...dotnetProperty(project, source, reference, new Set([`${source.file}:${key}`])),
          numericPrimary: key === "ApplicationDisplayVersion" ? "base" : undefined,
        };
      }
      const suffixSource =
        key === "VersionPrefix"
          ? sources
              .map((file) => ({
                ...file,
                span: oneSpan(
                  xmlSpans(file.raw ?? "", "Project/PropertyGroup/VersionSuffix"),
                  file.file,
                ),
              }))
              .find((file) => file.span)
          : undefined;
      return {
        ...source,
        span,
        prefix: key === "VersionPrefix",
        suffix: suffixSource?.file === source.file ? suffixSource.span : undefined,
        suffixSource: suffixSource?.file !== source.file ? suffixSource : undefined,
        nativeVersion:
          span.value + (suffixSource?.span?.value ? `-${suffixSource.span.value}` : ""),
        numericPrimary: key === "ApplicationDisplayVersion" ? "base" : undefined,
      };
    }
  }
  return original;
}

function dotnetProperty(
  project: ProjectDescriptor,
  original: ManifestSource,
  key: string,
  seen: Set<string>,
): ManifestSource {
  let source = original;
  while (true) {
    const identity = `${source.file}:${key}`;
    if (seen.has(identity)) throw new ProjectSourceError(`Cyclic MSBuild version property: ${key}`);
    seen.add(identity);
    const span = oneSpan(
      xmlSpans(source.raw ?? "", `Project/PropertyGroup/${key}`),
      `${source.file}: ${key}`,
    );
    if (span) {
      const reference = span.value.match(/^\$\(([A-Za-z_][\w.-]*)\)$/)?.[1];
      if (reference) return dotnetProperty(project, source, reference, seen);
      return { ...source, span, nativeVersion: span.value };
    }
    let directory = path.dirname(source.file);
    if (path.basename(source.file) === "Directory.Build.props") directory = path.dirname(directory);
    const next = path.join(directory, "Directory.Build.props");
    if (next === source.file || directory.startsWith("..")) break;
    source = loadSource(project, next);
    if (directory === "." && source.raw === null) break;
  }
  throw new ProjectSourceError(
    `Cannot resolve MSBuild version property ${key}; configure an explicit literal source`,
  );
}

export function rustSource(project: ProjectDescriptor, source: ManifestSource): ManifestSource {
  const own = sourceLine(source, "version", "package");
  const inline = /^\{\s*workspace\s*=\s*true\s*,?\s*\}$/.test(own.span?.value ?? "");
  if (own.span && !inline) return own;
  const inherited =
    inline ||
    sourceLine(source, "version.workspace", "package").span?.value === "true" ||
    sourceLine(source, "workspace", "package.version").span?.value === "true";
  const shared = sourceLine(source, "version", "workspace.package");
  if (shared.span && !inherited) return shared;
  if (!inherited) return own;
  let directory = path.dirname(path.dirname(source.file));
  while (directory !== ".." && !directory.startsWith(`..${path.sep}`)) {
    const parent = loadSource(project, path.join(directory, "Cargo.toml"));
    const version = sourceLine(parent, "version", "workspace.package");
    if (version.span) return version;
    if (directory === ".") break;
    directory = path.dirname(directory);
  }
  throw new ProjectSourceError(`Missing Cargo workspace version for ${source.file}`);
}

export function rustLockEdits(
  project: ProjectDescriptor,
  previous: string | null,
  target: string,
): FileEdit[] {
  const manifest = loadSource(project, path.join(project.directory, "Cargo.toml"));
  const name = sourceLine(manifest, "name", "package").span?.value;
  if (!name || !previous || previous === target) return [];
  let directory = project.directory;
  let lock = loadSource(project, path.join(directory, "Cargo.lock"));
  while (lock.raw === null && directory !== ".") {
    directory = path.dirname(directory);
    lock = loadSource(project, path.join(directory, "Cargo.lock"));
  }
  if (lock.raw === null) return [];
  const raw = lock.raw;
  const edits: { span: ValueSpan; value: string }[] = [];
  const sections = [...raw.matchAll(/^\[\[package\]\]\s*\r?$/gm)];
  const local = sections.filter((entry, index) => {
    const block = raw.slice(entry.index, sections[index + 1]?.index ?? raw.length);
    return (
      oneSpan(lineSpans(block, "name"), lock.file)?.value === name &&
      !lineSpans(block, "source").length
    );
  });
  if (!local.length) return [];
  if (local.length > 1)
    throw new ProjectSourceError(`Ambiguous local package ${name} in ${lock.file}`);
  for (let index = 0; index < sections.length; index++) {
    const start = sections[index]?.index ?? 0;
    const end = sections[index + 1]?.index ?? raw.length;
    const section = raw.slice(start, end);
    const version = oneSpan(lineSpans(section, "version"), lock.file);
    if (
      oneSpan(lineSpans(section, "name"), lock.file)?.value === name &&
      !lineSpans(section, "source").length &&
      version
    ) {
      if (version.value !== previous)
        throw new ProjectSourceError(`Local package ${name} has stale version in ${lock.file}`);
      edits.push({
        span: { ...version, start: version.start + start, end: version.end + start },
        value: target,
      });
    }
    const dependencies = section.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m);
    if (dependencies?.[1]) {
      const offset = start + (dependencies.index ?? 0) + dependencies[0].indexOf("[") + 1;
      for (const match of dependencies[1].matchAll(/"([^"\\\r\n]+)"/g)) {
        if (match[1] !== `${name} ${previous}`) continue;
        const position = offset + match.index + 1;
        edits.push({
          span: { start: position, end: position + match[1].length, value: match[1] },
          value: `${name} ${target}`,
        });
      }
    }
  }
  if (!edits.length) return [];
  return [
    {
      path: lock.file,
      before: raw,
      after: replaceSpans(raw, edits),
      changes: edits.map(({ span, value }) => ({ ...span, replacement: value })),
    },
  ];
}

export function javaSource(
  project: ProjectDescriptor,
  source: ManifestSource,
  visited = new Set<string>(),
): ManifestSource {
  const identity = path.normalize(source.file);
  if (visited.has(identity)) throw new ProjectSourceError(`Cyclic Maven parent: ${identity}`);
  visited.add(identity);
  const raw = source.raw ?? "";
  if (!source.file.endsWith("pom.xml")) {
    const own = sourceLine(source, "version", "");
    if (own.span && /^\d/.test(own.span.value)) return own;
    // Gradle property bindings are data, not executable expressions to evaluate.
    const property = raw.match(
      /^\s*version\s*=\s*(?:project\.)?(?:findProperty|property)\(["']([\w.-]+)["']\)(?:\s*(?:as String|\.toString\(\)))?\s*$/m,
    )?.[1];
    if (property)
      return sourceLine(
        loadSource(project, path.join(path.dirname(source.file), "gradle.properties")),
        property,
        "",
      );
    if (!own.span && !/^\s*version\s*=/m.test(raw) && !source.file.endsWith("gradle.properties")) {
      return sourceLine(
        loadSource(project, path.join(path.dirname(source.file), "gradle.properties")),
        "version",
        "",
      );
    }
    return own;
  }
  const span = oneSpan(xmlSpans(raw, "project/version"), source.file);
  if (span) {
    if (/^\$\{revision\}(?:\$\{sha1\})?\$\{changelist\}$/.test(span.value)) {
      const revision = mavenProperty(project, source, "revision");
      const suffix = mavenProperty(project, source, "changelist");
      const sha = mavenProperty(project, source, "sha1");
      if (!revision.span || !suffix.span || sha.span?.value)
        throw new ProjectSourceError(
          `Unresolved Maven CI version in ${source.file}; configure literal revision/changelist properties`,
        );
      return {
        ...revision,
        prefix: true,
        suffix: suffix.file === revision.file ? suffix.span : undefined,
        suffixSource: suffix.file === revision.file ? undefined : suffix,
        suffixIncludesDash: true,
        nativeVersion: revision.span.value + suffix.span.value,
      };
    }
    const property = span.value.match(/^\$\{([\w.-]+)\}$/)?.[1];
    if (property) return mavenProperty(project, source, property);
    return { ...source, span };
  }
  if (xmlSpans(raw, "project/parent/version").length) {
    if (/<relativePath\s*\/>/.test(raw))
      throw new ProjectSourceError(
        `External Maven parent requires an explicit version source: ${source.file}`,
      );
    const relative =
      oneSpan(xmlSpans(raw, "project/parent/relativePath"), source.file)?.value ?? "../pom.xml";
    if (!relative)
      throw new ProjectSourceError(
        `External Maven parent requires an explicit version source: ${source.file}`,
      );
    const parent = loadSource(project, path.join(path.dirname(source.file), relative));
    if (parent.file === source.file || parent.raw === null)
      throw new ProjectSourceError(`Cannot resolve Maven parent: ${source.file}`);
    const resolved = javaSource(project, parent, visited);
    const binding = oneSpan(xmlSpans(raw, "project/parent/version"), source.file);
    if (resolved.span && binding) {
      const expectedGroup = oneSpan(xmlSpans(raw, "project/parent/groupId"), source.file)?.value;
      const expectedArtifact = oneSpan(
        xmlSpans(raw, "project/parent/artifactId"),
        source.file,
      )?.value;
      const actualGroup =
        oneSpan(xmlSpans(parent.raw, "project/groupId"), parent.file)?.value ??
        oneSpan(xmlSpans(parent.raw, "project/parent/groupId"), parent.file)?.value;
      const actualArtifact = oneSpan(
        xmlSpans(parent.raw, "project/artifactId"),
        parent.file,
      )?.value;
      if (expectedGroup !== actualGroup || expectedArtifact !== actualArtifact)
        throw new ProjectSourceError(`Maven parent coordinates do not match ${parent.file}`);
      return {
        ...resolved,
        related: [
          ...(resolved.related ?? []),
          ...(binding.value.includes("$") ? [] : [{ ...source, span: binding }]),
        ],
      };
    }
  }
  return { ...source, span };
}

function mavenProperty(
  project: ProjectDescriptor,
  source: ManifestSource,
  property: string,
): ManifestSource {
  let directory = path.dirname(source.file);
  while (!directory.startsWith("..")) {
    const config = loadSource(project, path.join(directory, ".mvn/maven.config"));
    const override = sourceLine(config, `-D${property}`, "");
    if (override.span) return override;
    if (directory === ".") break;
    directory = path.dirname(directory);
  }
  return {
    ...source,
    span: oneSpan(xmlSpans(source.raw ?? "", `project/properties/${property}`), source.file),
  };
}

export function loadSource(project: ProjectDescriptor, file: string): ManifestSource {
  const absolute = projectPath(project.root, file);
  return {
    file,
    raw: project.snapshot?.has(file)
      ? (project.snapshot.get(file) ?? null)
      : fs.existsSync(absolute)
        ? fs.readFileSync(absolute, "utf8")
        : null,
  };
}

export function sourceLine(
  source: ManifestSource,
  key: string,
  section?: string,
  separator = "=",
): ManifestSource {
  return {
    ...source,
    span: oneSpan(lineSpans(source.raw ?? "", key, section, separator), `${source.file}: ${key}`),
  };
}

function literalAssignment(source: ManifestSource, key: string): ManifestSource {
  const raw = source.raw ?? "";
  const ignored = [
    ...raw.matchAll(/#[^\r\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g),
  ].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  const spans = [
    ...raw.matchAll(
      new RegExp(
        `${key === "__version__" ? "^" : "\\b"}${key}(?:[ \\t]*:[ \\t]*str)?[ \\t]*=[ \\t]*(["'])([^"'\\r\\n]+)\\1(?=\\s*[,;)#\\r\\n]|\\s*$)`,
        "gm",
      ),
    ),
  ]
    .filter(
      (match) => !ignored.some((range) => match.index >= range.start && match.index < range.end),
    )
    .map((match) => {
      const value = match[2] ?? "";
      const start = match.index + match[0].indexOf(match[1] ?? '"') + 1;
      return { start, end: start + value.length, value };
    });
  return { ...source, span: oneSpan(spans, `${source.file}: ${key}`) };
}

export function pythonSource(project: ProjectDescriptor, source: ManifestSource): ManifestSource {
  if (source.file.endsWith(".py")) {
    return literalAssignment(
      source,
      path.basename(source.file) === "setup.py" ? "version" : "__version__",
    );
  }
  if (source.file.endsWith("setup.cfg")) {
    const version = sourceLine(source, "version", "metadata");
    const directive = version.span?.value.match(/^(file|attr):\s*(.+)$/);
    if (directive?.[1] === "file" && directive[2]) {
      const backing = loadSource(
        project,
        path.join(path.dirname(source.file), directive[2].trim()),
      );
      if (backing.raw === null)
        throw new ProjectSourceError(`Missing Python version source: ${backing.file}`);
      const value = backing.raw.trim();
      const start = backing.raw.indexOf(value);
      return { ...backing, span: { start, end: start + value.length, value } };
    }
    if (directive?.[1] === "attr" && directive[2]) {
      const attr = directive[2].trim().match(/^([A-Za-z_][\w.]*)\.__version__$/)?.[1];
      if (!attr)
        throw new ProjectSourceError(`Unsupported Python version attribute in ${source.file}`);
      for (const suffix of [".py", "/__init__.py"]) {
        for (const prefix of ["", "src"]) {
          const backing = loadSource(
            project,
            path.join(project.directory, prefix, `${attr.replaceAll(".", "/")}${suffix}`),
          );
          if (backing.raw !== null) return literalAssignment(backing, "__version__");
        }
      }
      throw new ProjectSourceError(`Missing Python version attribute source in ${source.file}`);
    }
    return version;
  }
  const standard = sourceLine(source, "version", "project");
  const poetry = sourceLine(source, "version", "tool.poetry");
  if (standard.span && poetry.span && standard.span.value !== poetry.span.value) {
    throw new ProjectSourceError(`Conflicting Python versions in ${source.file}`);
  }
  if (standard.span || poetry.span)
    return standard.span ? { ...standard, related: poetry.span ? [poetry] : [] } : poetry;
  const raw = source.raw ?? "";
  const dynamic =
    raw.match(/^\[tool\.setuptools\.dynamic\]\s*\r?\n([\s\S]*?)(?=^\[|(?![\s\S]))/m)?.[1] ?? "";
  const file =
    sourceLine(source, "path", "tool.hatch.version").span?.value ??
    dynamic.match(/\bversion\s*=\s*\{\s*file\s*=\s*(?:\[\s*)?["']([^"']+)["']\s*(?:\]\s*)?\}/)?.[1];
  if (file) {
    const backing = loadSource(project, path.join(path.dirname(source.file), file));
    if (file.endsWith(".py")) return literalAssignment(backing, "__version__");
    if (backing.raw !== null) {
      const value = backing.raw.trim();
      const start = backing.raw.indexOf(value);
      return { ...backing, span: { start, end: start + value.length, value } };
    }
  }
  const attr = dynamic.match(/\battr\s*=\s*["']([A-Za-z_][\w.]*)\.__version__["']/)?.[1];
  if (attr) {
    for (const name of [
      `${attr.replaceAll(".", "/")}.py`,
      `${attr.replaceAll(".", "/")}/__init__.py`,
    ]) {
      for (const prefix of ["", "src"]) {
        const backing = loadSource(project, path.join(project.directory, prefix, name));
        if (backing.raw !== null) return literalAssignment(backing, "__version__");
      }
    }
  }
  return standard;
}
