import * as p from "@clack/prompts";

export function abort(): never {
  p.cancel("Operation cancelled.");
  process.exit(0);
}
