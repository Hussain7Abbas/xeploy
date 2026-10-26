# Repository Guidelines

## Project Structure & Module Organization

Xeploy manages GitHub releases for single repositories, mixed monorepos, and meta-repositories.

- `src/cli.ts` starts the interactive CLI; `src/cli-options.ts` validates arguments; `src/index.ts` exports the API.
- `src/flows.ts` and `src/meta.ts` orchestrate releases. `src/historical-release.ts` inspects historical trees; `src/release-journal.ts` handles durable recovery.
- `src/projects.ts`, `src/manifest-sources.ts`, and `src/project-platforms.ts` resolve native versions. Other `project-*.ts` modules handle configuration, edits, state, and preflight.
- `scripts/deploy.ts` wraps releases and optional publishing; `tests/*.test.ts` contains Bun fixtures and Git tests.
- `dist/` is generated; never edit it manually. No asset directory exists.
- `README.md` documents `.xeploy.json`. Keep `plan-v2.0/main.md` and phase documents synchronized during implementation.

## Build, Test, and Development Commands

Use Bun for dependencies, scripts, and temporary commands. Prefer these over Makefile targets that invoke npm.

| Command | Purpose |
| --- | --- |
| `bun install` | Install dependencies. |
| `bun run dev` | Rebuild on source changes. |
| `bun run build` | Generate ESM bundles and declarations. |
| `bun run typecheck` | Check strict TypeScript. |
| `bun run test` | Run fixtures and disposable Git tests; 60-second test timeout. |
| `bun run lint` | Lint `src/` with Biome. |
| `bun run format` | Format `src/` with Biome. |
| `bun run check` | Apply Biome checks and formatting fixes. |
| `node dist/cli.js --version` | Smoke-test the built CLI. |

The CLI requires Node.js 18+, Git, and authenticated GitHub CLI. Target-language SDKs and engines are unnecessary.

## Coding Style & Naming Conventions

Use strict TypeScript, ESM, and `.js` relative imports. Follow `biome.json`: two spaces, 100 columns, double quotes, and semicolons. Use camelCase functions, PascalCase types, and kebab-case filenames. Keep subprocess arguments in arrays; validate branches, tags, and paths. Prepare complete version batches before mutations.

## Testing Guidelines

Use Bun's built-in runner; no coverage threshold is configured. Before submitting, run tests, typecheck, lint, build, and the version smoke test. Cover RC/final translation, mixed layouts, subsets, counters, promotion, and `--resume` when relevant. Use disposable repositories, local bare remotes, and fake GitHub operations. Never publish real releases during tests.

## Commit & Pull Request Guidelines

Follow Conventional Commits: `feat:`, `fix:`, `docs:`, and `chore(release):`. Discuss significant changes in an issue first. PRs should explain behavior changes, link issues, and record validation; include terminal output for changed prompts.

## Documentation Maintenance

Synchronize this guide and affected README sections with behavior, configuration, commands, and structure. Preserve unrelated user edits.
