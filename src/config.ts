import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DeployConfig {
  /** Relative paths (from project root) of package.json files to version-bump on each release */
  versionFiles: string[];
  /** Branch to sync after a staging release. Defaults to "staging" */
  stagingBranch: string;
  /** Branch to sync after a production release. Defaults to "main" */
  productionBranch: string;
}

const DEFAULTS: DeployConfig = {
  versionFiles: ['package.json'],
  stagingBranch: 'staging',
  productionBranch: 'main',
};

const CONFIG_NAMES = ['gdeploy.config.json', '.gdeployrc.json'];

export function loadConfig(cwd: string = process.cwd()): DeployConfig {
  for (const name of CONFIG_NAMES) {
    const file = path.join(cwd, name);
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DeployConfig>;
        return { ...DEFAULTS, ...raw };
      } catch {
        console.warn(`[gdeploy] Failed to parse ${name} — using defaults.`);
      }
    }
  }
  return { ...DEFAULTS };
}
