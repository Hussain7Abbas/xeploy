#!/usr/bin/env node
import * as p from '@clack/prompts';
import { loadConfig } from './config.js';
import { ensurePrereqs, getLatestTag, getTags } from './git.js';
import { flowOldRelease, flowProduction, flowStaging } from './flows.js';
import { formatSemVer } from './semver.js';

const cwd = process.cwd();
const config = loadConfig(cwd);

p.intro('🚀  GitHub Deploy Pipeline');

ensurePrereqs();

const tags = getTags();
const latest = getLatestTag(tags);

if (latest) {
  p.log.info(`Latest release: ${formatSemVer(latest)}`);
} else {
  p.log.warn('No releases yet — empty-repo mode.');
}

const topChoice = await p.select<'new' | 'old'>({
  message: 'What would you like to do?',
  options: [
    { label: 'Deploy new release', value: 'new' },
    { label: 'Deploy old release', value: 'old' },
  ],
});

if (p.isCancel(topChoice)) {
  p.cancel('Operation cancelled.');
  process.exit(0);
}

if (topChoice === 'old') {
  await flowOldRelease(tags, config, cwd);
  p.outro('Done ✔');
  process.exit(0);
}

const envChoice = await p.select<'staging' | 'production'>({
  message: 'Deploy target',
  options: [
    { label: 'Staging  (pre-release)', value: 'staging' },
    { label: 'Production  (final)', value: 'production' },
  ],
});

if (p.isCancel(envChoice)) {
  p.cancel('Operation cancelled.');
  process.exit(0);
}

if (envChoice === 'staging') {
  await flowStaging(tags, config, cwd);
} else {
  await flowProduction(tags, config, cwd);
}

p.outro('Done ✔');
