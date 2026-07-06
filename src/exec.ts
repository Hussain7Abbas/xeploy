import { spawnSync } from "node:child_process";

export interface SpawnOpts {
  cwd?: string;
  inherit?: boolean;
  trim?: boolean;
}

export function spawnSyncFile(cmd: string, args: string[], opts?: SpawnOpts): string {
  const result = spawnSync(cmd, args, {
    cwd: opts?.cwd,
    encoding: "utf8",
    stdio: opts?.inherit ? "inherit" : "pipe",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    throw new Error(`${cmd} ${args.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`);
  }

  const stdout = result.stdout?.toString() ?? "";
  if (opts?.inherit) {
    return "";
  }
  return opts?.trim === false ? stdout : stdout.trim();
}

export function trySpawnSyncFile(cmd: string, args: string[], opts?: SpawnOpts): string | null {
  try {
    return spawnSyncFile(cmd, args, opts);
  } catch {
    return null;
  }
}
