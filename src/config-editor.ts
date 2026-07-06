import * as p from "@clack/prompts";
import {
  CREATE_PR_ENVS,
  type CreatePrEnv,
  ENV_NAMES,
  type EnvName,
  type RepoType,
  type XBumpConfig,
  createDefaultConfig,
  formatConfigValue,
  loadConfig,
  validateConfig,
  writeConfig,
} from "./config.js";
import { listBranches } from "./git.js";
import { abort } from "./prompts-util.js";
import { isValidBranchName } from "./validate.js";

async function editBoolean(
  message: string,
  current: boolean,
): Promise<boolean> {
  const choice = await p.confirm({ message, initialValue: current });
  if (p.isCancel(choice)) {
    abort();
  }
  return choice;
}

async function pickBranch(cwd: string, message: string): Promise<string> {
  const branches = listBranches(cwd);
  if (branches.length === 0) {
    p.log.warn("No branches found.");
    const manual = await p.text({
      message: "Enter branch name:",
      validate: (v) => {
        if (!v) {
          return "Branch name is required";
        }
        if (!isValidBranchName(v)) {
          return "Invalid branch name";
        }
      },
    });
    if (p.isCancel(manual) || !manual) {
      abort();
    }
    return manual;
  }

  const choice = await p.select({
    message,
    options: [
      ...branches.map((b) => ({ label: b, value: b })),
      { label: "Clear (set to null)", value: "__null__" },
    ],
  });
  if (p.isCancel(choice)) {
    abort();
  }
  return choice === "__null__" ? "" : (choice as string);
}

async function editType(config: XBumpConfig, cwd: string): Promise<void> {
  const choice = await p.select<RepoType>({
    message: "Repository type",
    options: [
      { label: "default", value: "default" },
      { label: "mono", value: "mono" },
      { label: "meta", value: "meta" },
    ],
    initialValue: config.type,
  });
  if (p.isCancel(choice)) {
    abort();
  }
  config.type = choice;

  if (choice === "mono" || choice === "meta") {
    const detected = createDefaultConfig(cwd).subprojectsDir ?? "apps";
    const dir = await p.text({
      message: "Sub-projects directory (parent folder):",
      initialValue: config.subprojectsDir ?? detected,
    });
    if (p.isCancel(dir)) {
      abort();
    }
    config.subprojectsDir = (dir as string) || null;

    if (choice === "meta") {
      const defaults = createDefaultConfig(cwd);
      config.meta = defaults.meta;
    }
  } else {
    config.subprojectsDir = null;
    config.meta = undefined;
  }
}

async function editCreatePr(
  createPr: Record<CreatePrEnv, boolean>,
  cwd: string,
): Promise<void> {
  void cwd;
  const env = await p.select<CreatePrEnv>({
    message: "Select environment for create_pr",
    options: CREATE_PR_ENVS.map((e) => ({
      label: `${e}: ${createPr[e]}`,
      value: e,
    })),
  });
  if (p.isCancel(env)) {
    abort();
  }
  createPr[env] = await editBoolean(`Create PR for ${env}?`, createPr[env]);
}

async function editEnvironments(
  environments: Record<EnvName, string | null>,
  cwd: string,
): Promise<void> {
  const env = await p.select<EnvName>({
    message: "Select environment to map",
    options: ENV_NAMES.map((e) => ({
      label: `${e}: ${formatConfigValue(environments[e])}`,
      value: e,
    })),
  });
  if (p.isCancel(env)) {
    abort();
  }

  const branch = await pickBranch(
    cwd,
    `Branch for "${env}" (type to filter in list):`,
  );
  environments[env] = branch || null;
}

async function editMetaConfig(config: XBumpConfig, cwd: string): Promise<void> {
  if (!config.meta || config.meta.length === 0) {
    p.log.warn('No meta subrepos configured. Set type to "meta" first.');
    return;
  }

  const repo = await p.select<string>({
    message: "Select subrepo",
    options: config.meta.map((m) => ({ label: m.repo, value: m.repo })),
  });
  if (p.isCancel(repo)) {
    abort();
  }

  const metaEntry = config.meta.find((m) => m.repo === repo);
  if (!metaEntry) {
    return;
  }

  const field = await p.select<"create_pr" | "environments">({
    message: `Edit config for "${repo}"`,
    options: [
      { label: "create_pr", value: "create_pr" },
      { label: "environments", value: "environments" },
    ],
  });
  if (p.isCancel(field)) {
    abort();
  }

  if (field === "create_pr") {
    await editCreatePr(metaEntry.create_pr, cwd);
  } else {
    await editEnvironments(metaEntry.environments, cwd);
  }
}

async function editVersionFiles(config: XBumpConfig): Promise<void> {
  const current = config.versionFiles.join(", ");
  const input = await p.text({
    message: "Version files (comma-separated paths):",
    initialValue: current,
  });
  if (p.isCancel(input)) {
    abort();
  }
  config.versionFiles = (input as string)
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}

async function editSubprojectsDir(config: XBumpConfig): Promise<void> {
  const input = await p.text({
    message: "Sub-projects directory:",
    initialValue: config.subprojectsDir ?? "",
  });
  if (p.isCancel(input)) {
    abort();
  }
  config.subprojectsDir = (input as string) || null;
}

type ConfigKey =
  | "type"
  | "subprojectsDir"
  | "versionFiles"
  | "generate_release_notes"
  | "create_production_release_branch"
  | "create_pr"
  | "environments"
  | "meta";

function configMenuOptions(
  config: XBumpConfig,
): { label: string; value: ConfigKey }[] {
  const options: { label: string; value: ConfigKey }[] = [
    { label: `type: ${config.type}`, value: "type" },
    {
      label: `generate_release_notes: ${config.generate_release_notes}`,
      value: "generate_release_notes",
    },
    {
      label: `create_production_release_branch: ${config.create_production_release_branch}`,
      value: "create_production_release_branch",
    },
    {
      label: `create_pr: ${formatConfigValue(config.create_pr)}`,
      value: "create_pr",
    },
    {
      label: `environments: ${formatConfigValue(config.environments)}`,
      value: "environments",
    },
    {
      label: `versionFiles: ${config.versionFiles.join(", ")}`,
      value: "versionFiles",
    },
  ];

  if (config.type === "mono" || config.type === "meta") {
    options.splice(1, 0, {
      label: `subprojectsDir: ${formatConfigValue(config.subprojectsDir)}`,
      value: "subprojectsDir",
    });
  }

  if (config.type === "meta") {
    options.push({
      label: `meta: ${config.meta?.length ?? 0} subrepos`,
      value: "meta",
    });
  }

  return options;
}

export async function runConfigEditor(
  config: XBumpConfig,
  cwd: string,
): Promise<void> {
  let editing = true;

  while (editing) {
    const key = await p.select<ConfigKey | "done">({
      message: "Select config to edit",
      options: [...configMenuOptions(config), { label: "Done", value: "done" }],
    });
    if (p.isCancel(key) || key === "done") {
      editing = false;
      break;
    }

    switch (key) {
      case "type":
        await editType(config, cwd);
        break;
      case "subprojectsDir":
        await editSubprojectsDir(config);
        break;
      case "versionFiles":
        await editVersionFiles(config);
        break;
      case "generate_release_notes":
        config.generate_release_notes = await editBoolean(
          "Generate release notes?",
          config.generate_release_notes,
        );
        break;
      case "create_production_release_branch":
        config.create_production_release_branch = await editBoolean(
          "Create production release branch (release/X.Y.Z)?",
          config.create_production_release_branch,
        );
        break;
      case "create_pr":
        await editCreatePr(config.create_pr, cwd);
        break;
      case "environments":
        await editEnvironments(config.environments, cwd);
        break;
      case "meta":
        await editMetaConfig(config, cwd);
        break;
    }

    validateConfig(config, cwd);
    writeConfig(cwd, config);
    p.log.success("Config saved.");
  }
}

export async function ensureConfig(cwd: string): Promise<XBumpConfig> {
  let config = loadConfig(cwd);

  if (!config) {
    const create = await p.confirm({
      message: "No .xbump.json found. Create one?",
      initialValue: true,
    });
    if (p.isCancel(create)) {
      p.cancel("Operation cancelled.");
      process.exit(0);
    }
    if (create) {
      config = createDefaultConfig(cwd);
      writeConfig(cwd, config);
      p.log.success("Created .xbump.json");
    } else {
      config = createDefaultConfig(cwd);
    }
  }

  return config;
}
