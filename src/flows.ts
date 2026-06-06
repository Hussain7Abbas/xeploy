import * as p from '@clack/prompts';
import type { DeployConfig } from './config.js';
import {
  createRelease,
  currentBranch,
  getLatestFinalTag,
  getLatestRcTag,
  getLatestTag,
  getRcTags,
  ghReleaseExists,
  republishRc,
  requireCleanTree,
  syncBranch,
  tagExists,
} from './git.js';
import { bumpVersion, compareSemVer, formatSemVer, parseSemVer } from './semver.js';
import type { BumpType, SemVer } from './semver.js';
import { bumpVersionFiles } from './versions.js';

function abort(): never {
  p.cancel('Operation cancelled.');
  process.exit(0);
}

function releaseNote(tag: string, notesStart: string | null, prerelease: boolean): string {
  const lines = [
    `Tag:         ${tag}  (${prerelease ? 'pre-release' : 'final'})`,
    `Notes since: ${notesStart ?? 'beginning of history'}`,
  ];
  return lines.join('\n');
}

export async function flowStaging(
  tags: SemVer[],
  config: DeployConfig,
  cwd: string,
): Promise<void> {
  const latest = getLatestTag(tags);
  const latestStr = latest ? formatSemVer(latest) : '(none)';

  const bumpChoice = await p.select<BumpType | 'custom'>({
    message: `Select bump type  (current latest: ${latestStr})`,
    options: [
      {
        label: `Release Candidate  →  ${formatSemVer(bumpVersion('rc', latest))}`,
        value: 'rc',
      },
      {
        label: `Bug Fix            →  ${formatSemVer(bumpVersion('bugfix', latest))}`,
        value: 'bugfix',
      },
      {
        label: `Minor              →  ${formatSemVer(bumpVersion('minor', latest))}`,
        value: 'minor',
      },
      {
        label: `Major              →  ${formatSemVer(bumpVersion('major', latest))}`,
        value: 'major',
      },
      { label: 'Custom', value: 'custom' },
    ],
  });
  if (p.isCancel(bumpChoice)) {
    abort();
  }

  let newTag: string;
  if (bumpChoice === 'custom') {
    const customTag = await p.text({
      message: 'Enter custom version (e.g. 1.2.3-rc.1):',
      validate: (v) => {
        if (!v) {
          return 'Version is required';
        }
        if (!/^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(v)) {
          return 'Format must be X.Y.Z or X.Y.Z-rc.N';
        }
        if (tagExists(v)) {
          return `Tag "${v}" already exists`;
        }
        const parsed = parseSemVer(v);
        if (parsed && latest && compareSemVer(parsed, latest) <= 0) {
          return `Version must be greater than current latest "${latestStr}"`;
        }
      },
    });
    if (p.isCancel(customTag)) {
      abort();
    }
    newTag = customTag as string;
  } else {
    newTag = formatSemVer(bumpVersion(bumpChoice as BumpType, latest));
  }

  const notesStartTag = latest ? latestStr : null;
  const branch = currentBranch();

  p.note(
    [
      releaseNote(newTag, notesStartTag, true),
      `Branch:      ${branch}`,
      `Version files: ${config.versionFiles.join(', ')}`,
    ].join('\n'),
    'Release summary',
  );

  const ok = await p.confirm({ message: 'Proceed?', initialValue: true });
  if (p.isCancel(ok) || !ok) {
    abort();
  }

  requireCleanTree();

  const s = p.spinner();
  s.start(`Bumping version to ${newTag}`);
  bumpVersionFiles(newTag, config.versionFiles, cwd);
  s.stop('Version bumped and committed');

  s.start(`Creating pre-release ${newTag}`);
  createRelease({ tag: newTag, prerelease: true, notesStartTag, branch });
  s.stop(`Release ${newTag} created`);

  await syncBranch(config.stagingBranch, newTag, branch);
}

export async function flowProduction(
  tags: SemVer[],
  config: DeployConfig,
  cwd: string,
): Promise<void> {
  const latestRc = getLatestRcTag(tags);
  if (!latestRc) {
    p.cancel('No release candidates found. Create a staging release first.');
    process.exit(1);
  }

  const rcTag = formatSemVer(latestRc);
  const finalVer: SemVer = { ...latestRc, rc: null };
  const finalTag = formatSemVer(finalVer);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartTag = latestFinal ? formatSemVer(latestFinal) : null;
  const branch = currentBranch();

  p.note(
    [
      `Source RC:   ${rcTag}`,
      releaseNote(finalTag, notesStartTag, false),
      `Branch:      ${branch}`,
      `Version files: ${config.versionFiles.join(', ')}`,
    ].join('\n'),
    'Release summary',
  );

  const ok = await p.confirm({ message: 'Proceed?', initialValue: true });
  if (p.isCancel(ok) || !ok) {
    abort();
  }

  requireCleanTree();

  const s = p.spinner();
  s.start(`Bumping version to ${finalTag}`);
  bumpVersionFiles(finalTag, config.versionFiles, cwd);
  s.stop('Version bumped and committed');

  s.start(`Creating final release ${finalTag}`);
  createRelease({ tag: finalTag, prerelease: false, notesStartTag, branch });
  s.stop(`Release ${finalTag} created`);

  await syncBranch(config.productionBranch, finalTag, branch);
}

export async function flowOldRelease(
  tags: SemVer[],
  config: DeployConfig,
  cwd: string,
): Promise<void> {
  const rcTags = getRcTags(tags);
  if (rcTags.length === 0) {
    p.cancel('No release candidate tags found.');
    process.exit(1);
  }

  const chosen = await p.select<string>({
    message: 'Select a previous RC release',
    options: rcTags.map((v) => ({ label: formatSemVer(v), value: formatSemVer(v) })),
  });
  if (p.isCancel(chosen)) {
    abort();
  }

  const action = await p.select<'promote' | 'republish'>({
    message: `What to do with ${chosen}?`,
    options: [
      {
        label: `Promote to production  →  ${(chosen as string).replace(/-rc\.\d+$/, '')}  (final)`,
        value: 'promote',
      },
      { label: `Re-publish as same RC  →  ${chosen}`, value: 'republish' },
    ],
  });
  if (p.isCancel(action)) {
    abort();
  }

  if (action === 'republish') {
    const alreadyExists = ghReleaseExists(chosen as string);
    p.note(
      [
        `Tag: ${chosen}  (pre-release, unchanged)`,
        alreadyExists ? 'Existing GitHub release will be deleted and re-created.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
      'Re-publish summary',
    );
    const ok = await p.confirm({ message: 'Proceed?', initialValue: true });
    if (p.isCancel(ok) || !ok) {
      abort();
    }
    const s = p.spinner();
    s.start(`Re-publishing ${chosen}`);
    republishRc(chosen as string);
    s.stop(`Re-published ${chosen}`);
    return;
  }

  // promote
  const parsed = parseSemVer(chosen as string);
  if (!parsed) {
    p.cancel('Invalid tag selected.');
    process.exit(1);
  }
  const finalVer: SemVer = { ...parsed, rc: null };
  const finalTag = formatSemVer(finalVer);
  const latestFinal = getLatestFinalTag(tags);
  const notesStartTag = latestFinal ? formatSemVer(latestFinal) : null;
  const branch = currentBranch();

  p.note(
    [
      `Source RC:   ${chosen}`,
      releaseNote(finalTag, notesStartTag, false),
      `Branch:      ${branch}`,
      `Version files: ${config.versionFiles.join(', ')}`,
    ].join('\n'),
    'Promote summary',
  );

  const ok = await p.confirm({ message: 'Proceed?', initialValue: true });
  if (p.isCancel(ok) || !ok) {
    abort();
  }

  requireCleanTree();

  const s = p.spinner();
  s.start(`Bumping version to ${finalTag}`);
  bumpVersionFiles(finalTag, config.versionFiles, cwd);
  s.stop('Version bumped and committed');

  s.start(`Creating final release ${finalTag}`);
  createRelease({ tag: finalTag, prerelease: false, notesStartTag, branch });
  s.stop(`Release ${finalTag} created`);

  await syncBranch(config.productionBranch, finalTag, branch);
}
