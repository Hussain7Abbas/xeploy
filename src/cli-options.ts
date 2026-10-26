import type { ReleaseEnv } from "./config.js";
import { RELEASE_ENVS } from "./config.js";
import type { BumpType } from "./semver.js";
import { assertReleaseVersion } from "./validate.js";

export interface ReleaseOptions {
  version?: string;
  bump?: BumpType;
  unify?: boolean;
  environments?: ReleaseEnv[];
}

export interface CliOptions extends ReleaseOptions {
  showVersion: boolean;
  help: boolean;
  resume?: boolean;
}

export function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = { showVersion: false, help: false };
  const seen = new Set<string>();
  const environments = new Map<ReleaseEnv, boolean>();
  const bumpFlags: Record<string, BumpType> = {
    "--rc": "rc",
    "--hotfix": "bugfix",
    "--minor": "minor",
    "--major": "major",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    let value = separator === -1 ? undefined : arg.slice(separator + 1);
    if (seen.has(flag)) {
      throw new Error(`Duplicate argument: ${flag}`);
    }
    seen.add(flag);

    if (flag === "--unify" || Object.hasOwn(bumpFlags, flag)) {
      if (value !== undefined) {
        throw new Error(`${flag} does not accept a value`);
      }
      if (flag === "--unify") {
        options.unify = true;
      } else {
        if (options.bump) {
          throw new Error(
            "Choose only one bump option: --rc, --hotfix, --minor, --major, or --bump",
          );
        }
        options.bump = bumpFlags[flag];
      }
      continue;
    }

    if (flag === "--resume") {
      if (value !== undefined) throw new Error("--resume does not accept a value");
      options.resume = true;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      if (value !== undefined) {
        throw new Error(`${flag} does not accept a value`);
      }
      options.help = true;
      continue;
    }

    const env = RELEASE_ENVS.find((name) => flag === `--${name}`);
    if (flag !== "--version" && flag !== "--bump" && !env) {
      throw new Error(`Unknown argument: ${arg}. Run xeploy --help for usage.`);
    }

    const next = args[i + 1];
    if (value === undefined && next !== undefined && !next.startsWith("-")) {
      value = next;
      i++;
    }

    if (flag === "--version") {
      if (value === undefined) {
        options.showVersion = true;
      } else {
        options.version = assertReleaseVersion(value);
      }
    } else if (flag === "--bump") {
      if (options.bump) {
        throw new Error("Choose only one bump option: --rc, --hotfix, --minor, --major, or --bump");
      }
      if (value !== "rc" && value !== "bugfix" && value !== "minor" && value !== "major") {
        throw new Error("--bump requires rc, bugfix, minor, or major");
      }
      options.bump = value;
    } else if (env) {
      if (value !== "1" && value !== "0" && value !== "true" && value !== "false") {
        throw new Error(`${flag} requires 1 or 0 (or true or false)`);
      }
      environments.set(env, value === "1" || value === "true");
    }
  }

  if (environments.size > 0) {
    options.environments = RELEASE_ENVS.filter((env) => environments.get(env));
    if (options.environments.length === 0) {
      throw new Error("Select at least one release environment with a value of 1");
    }
  }
  if (
    options.resume &&
    (options.version ||
      options.showVersion ||
      options.bump ||
      options.environments ||
      options.unify)
  )
    throw new Error("Use --resume by itself to continue the saved release");
  if (options.version && options.bump) {
    throw new Error("Use either --version <release> or a bump option, not both");
  }
  if (options.showVersion && (options.bump || options.environments || options.unify)) {
    throw new Error("--version without a value prints the CLI version; provide a release version");
  }
  return options;
}

export const CLI_HELP = `Usage: xeploy [options]

With no arguments, start the interactive release menu.
Release arguments start a new release; omitted choices are prompted.

  --version                  Print the Xeploy CLI version
  --version <X.Y.Z[-rc.N]>     Set the release version (without a tag prefix)
  --bump <type>               Choose rc, bugfix, minor, or major
  --rc                       Automatically bump the release candidate number
  --hotfix                   Automatically bump the patch version
  --minor                    Automatically bump the minor version
  --major                    Automatically bump the major version
  --resume                   Continue the saved release after a failure
  --unify                    Unify differing selected repo versions using the highest
  --staging <1|0>             Select/exclude staging (RC)
  --uat <1|0>                 Select/exclude UAT (RC)
  --sandbox <1|0>             Select/exclude sandbox (final)
  --production <1|0>          Select/exclude production (final)
  --help, -h                  Show this help

Environment flags also accept true/false. The selected flags define all targets;
environments omitted from those flags are excluded. Confirmation is still required.
Both --option value and --option=value are supported.

Examples:
  xeploy --version 1.0.1-rc.6 --uat 1
  xeploy --uat 1 --bump rc
  xeploy --version 1.0.1 --production 1
  xeploy --bump minor --staging 1 --uat 1
  xeploy --minor --uat 1 --unify
`;
