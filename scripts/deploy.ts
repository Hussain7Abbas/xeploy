#!/usr/bin/env node
import { execSync } from 'child_process';
import * as p from '@clack/prompts';
import { loadConfig } from '../src/config.js';
import { ensurePrereqs, getLatestTag, getTags } from '../src/git.js';
import { flowOldRelease, flowProduction, flowStaging } from '../src/flows.js';
import { formatSemVer } from '../src/semver.js';

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

let deployType: 'staging' | 'production';

if (envChoice === 'staging') {
  await flowStaging(tags, config, cwd);
  deployType = 'staging';
} else {
  await flowProduction(tags, config, cwd);
  deployType = 'production';
}

p.outro('Done ✔');

// Now handle NPM publishing
p.intro('📦  Publishing to npm');

const latestTags = getTags();
const latestTag = getLatestTag(latestTags);
if (!latestTag) {
  p.cancel('Could not determine latest tag for publishing.');
  process.exit(1);
}

const tagStr = formatSemVer(latestTag);

try {
  if (deployType === 'staging') {
    p.log.info(`Publishing beta release: ${tagStr}`);
    execSync('make publish-beta', { stdio: 'inherit', cwd });
  } else {
    p.log.info(`Publishing production release: ${tagStr}`);
    execSync('make publish-dry', { stdio: 'inherit', cwd });
    p.log.step('Dry-run successful');
    execSync('make publish', { stdio: 'inherit', cwd });
  }
  p.outro('✨  Deploy and publish complete!');
} catch (error) {
  p.cancel('Publishing failed.');
  process.exit(1);
}
