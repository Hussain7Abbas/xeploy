import * as p from "@clack/prompts";

export const BACK = Symbol("back");

export function isBack(value: unknown): value is typeof BACK {
  return value === BACK;
}

export function cancelAsBack<T>(value: T | symbol): T | typeof BACK {
  if (p.isCancel(value)) {
    return BACK;
  }
  return value as T;
}

export function abort(): never {
  p.cancel("Operation cancelled.");
  process.exit(0);
}
