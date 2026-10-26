import * as fs from "node:fs";
import * as path from "node:path";
import type { FileEdit } from "./project-model.js";
import { ProjectSourceError, projectPath } from "./project-model.js";

export interface ValueSpan {
  start: number;
  end: number;
  value: string;
}

export function replaceSpans(raw: string, values: { span: ValueSpan; value: string }[]): string {
  let result = raw;
  let boundary = raw.length;
  for (const { span, value } of [...values].sort((a, b) => b.span.start - a.span.start)) {
    if (span.end > boundary || raw.slice(span.start, span.end) !== span.value) {
      throw new ProjectSourceError("Overlapping or stale version edits");
    }
    result = result.slice(0, span.start) + value + result.slice(span.end);
    boundary = span.start;
  }
  return result;
}

/** Locate JSON top-level scalar fields without reserializing the document. */
export function jsonSpans(raw: string): Map<string, ValueSpan> {
  JSON.parse(raw);
  const fields = new Map<string, ValueSpan>();
  const token = /"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?|true|false|null/g;
  let depth = 0;
  let key: string | undefined;
  let readingValue = false;
  for (const match of raw.matchAll(token)) {
    const value = match[0];
    if (value === "{" || value === "[") {
      depth++;
      continue;
    }
    if (value === "}" || value === "]") {
      depth--;
      continue;
    }
    if (depth !== 1) continue;
    if (value === ",") {
      key = undefined;
      readingValue = false;
      continue;
    }
    if (value === ":") {
      readingValue = true;
      continue;
    }
    if (!readingValue) {
      key = JSON.parse(value) as string;
      continue;
    }
    if (!key) continue;
    if (fields.has(key)) throw new ProjectSourceError(`Duplicate JSON field: ${key}`);
    const quoted = value.startsWith('"');
    const start = match.index + (quoted ? 1 : 0);
    fields.set(key, {
      start,
      end: match.index + value.length - (quoted ? 1 : 0),
      value: quoted ? value.slice(1, -1) : value,
    });
  }
  return fields;
}

/** Single-line literal declarations, scoped by exact INI/TOML section or YAML root. */
export function lineSpans(
  raw: string,
  key: string,
  section?: string,
  separator = "=",
): ValueSpan[] {
  const result: ValueSpan[] = [];
  let current = "";
  let offset = 0;
  for (const line of raw.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const header = line.match(/^\s*\[([^\]\r\n]+)\]\s*(?:[#;].*)?\r?\n?$/);
    if (header) current = header[1] ?? "";
    if (section === undefined || current === section) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        `^${separator === ":" && section === "" ? "" : "[ \\t]*"}(${escaped}[ \\t]*${separator}[ \\t]*)([^\\r\\n]*)`,
      );
      const match = line.match(pattern);
      if (match) {
        const scalar = match[2] ?? "";
        const literal = scalar.match(/^(?:"([^"\\]*)"|'([^']*)'|([^#;]*?))\s*(?:[#;].*)?$/);
        if (!literal) throw new ProjectSourceError(`Unsupported value for ${key}`);
        const value = (literal[1] ?? literal[2] ?? literal[3] ?? "").trimEnd();
        const quoted = scalar.startsWith('"') || scalar.startsWith("'");
        const start =
          offset + (match.index ?? 0) + match[0].length - scalar.length + (quoted ? 1 : 0);
        result.push({ start, end: start + value.length, value });
      }
    }
    offset += line.length;
  }
  return result;
}

export function oneSpan(spans: ValueSpan[], label: string): ValueSpan | undefined {
  if (spans.length > 1)
    throw new ProjectSourceError(`Ambiguous ${label}; configure an explicit version source`);
  return spans[0];
}

/** Read literal XML element text by ancestry; never evaluates imports or entities. */
export function xmlSpans(raw: string, elementPath: string): ValueSpan[] {
  const stack: { name: string; start: number; conditional: boolean }[] = [];
  const spans: ValueSpan[] = [];
  for (const match of raw.matchAll(/<!--[\s\S]*?-->|<[^>]+>/g)) {
    const tag = match[0];
    if (tag.startsWith("<!--") || tag.startsWith("<?")) continue;
    if (tag.startsWith("<!"))
      throw new ProjectSourceError("Unsupported XML declaration in version source");
    const name = tag
      .match(/^<\/?([\w:.-]+)/)?.[1]
      ?.split(":")
      .pop();
    if (!name) throw new ProjectSourceError("Malformed XML version source");
    if (tag.startsWith("</")) {
      const fullPath = stack.map((item) => item.name).join("/");
      const entry = stack.pop();
      if (!entry || entry.name !== name)
        throw new ProjectSourceError("Malformed XML version source");
      if (fullPath === elementPath) {
        if (entry.conditional || stack.some((item) => item.conditional)) {
          throw new ProjectSourceError(
            `Conditional ${elementPath}; configure an unambiguous version source`,
          );
        }
        const text = raw.slice(entry.start, match.index);
        if (text.includes("<") || text.includes("&"))
          throw new ProjectSourceError(`Non-literal ${elementPath}`);
        const value = text.trim();
        const start = entry.start + text.indexOf(value);
        spans.push({ start, end: start + value.length, value });
      }
    } else if (
      tag.endsWith("/>") &&
      [...stack.map((item) => item.name), name].join("/") === elementPath
    ) {
      throw new ProjectSourceError(
        `Expand self-closing ${elementPath} to an explicit literal element before releasing`,
      );
    } else if (!tag.endsWith("/>"))
      stack.push({
        name,
        start: match.index + tag.length,
        conditional: /\bCondition\s*=/.test(tag),
      });
  }
  if (stack.length) throw new ProjectSourceError("Unclosed XML version source");
  return spans;
}

export function plistSpans(raw: string, key: string): ValueSpan[] {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...raw
      .replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length))
      .matchAll(
        new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<(string|integer)>([^<]*)</\\1>`, "g"),
      ),
  ].map((match) => {
    const value = match[2] ?? "";
    const start = match.index + match[0].lastIndexOf(`>${value}<`) + 1;
    return { start, end: start + value.length, value };
  });
}

/** Check all originals first; restore local files if any write in the batch fails. */
export function applyFileEdits(root: string, edits: FileEdit[], allowApplied = false): string[] {
  const unique = new Map<string, FileEdit>();
  for (const edit of edits) {
    const absolute = projectPath(root, edit.path);
    const old = unique.get(absolute);
    if (old && (old.after !== edit.after || old.before !== edit.before)) {
      throw new ProjectSourceError(`Conflicting version edits for ${edit.path}`);
    }
    unique.set(absolute, edit);
  }
  for (const [absolute, edit] of unique) {
    const current = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : null;
    if (current !== edit.before && !(allowApplied && current === edit.after))
      throw new ProjectSourceError(`Version source changed since planning: ${edit.path}`);
    if (!fs.existsSync(path.dirname(absolute)))
      throw new ProjectSourceError(`Missing directory for ${edit.path}`);
  }
  const written: string[] = [];
  const alreadyApplied: string[] = [];
  try {
    for (const [absolute, edit] of unique) {
      if (edit.before === edit.after) continue;
      if (
        allowApplied &&
        fs.existsSync(absolute) &&
        fs.readFileSync(absolute, "utf8") === edit.after
      ) {
        alreadyApplied.push(absolute);
        continue;
      }
      written.push(absolute);
      fs.writeFileSync(absolute, edit.after);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const absolute of written.reverse()) {
      const edit = unique.get(absolute);
      if (!edit) continue;
      try {
        const current = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : null;
        if (current === edit.before) continue;
        if (edit.before === null) fs.unlinkSync(absolute);
        else fs.writeFileSync(absolute, edit.before);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length)
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Version batch failed and local rollback was incomplete",
      );
    throw error;
  }
  return [...written, ...alreadyApplied].map((absolute) => path.relative(root, absolute));
}
