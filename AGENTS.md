# Repository Guidelines

## Project Structure & Module Organization

Xeploy is a GitHub release CLI supporting single repositories, monorepos, and meta-repositories.

- `src/cli.ts` provides the interactive entry point; `src/index.ts` exports the programmatic API.
- `src/flows.ts` and `src/meta.ts` orchestrate releases. Sibling modules handle configuration, Git, versioning, discovery, and validation.
- `scripts/deploy.ts` wraps the CLI and optional package publishing.
- `src/cli-options.ts` parses validated release arguments; `tests/` covers argument handling and disposable-repository release flows.
- Release arguments include explicit versions, bump shortcuts (`--rc`, `--hotfix`, `--minor`, `--major`), environment selection, and optional mono/meta version unification (`--unify`).
- `dist/` contains generated bundles and declarations; do not edit manually.
- `README.md` documents usage and `.xeploy.json` configuration. No dedicated asset directory currently exists.
- `plan-v2.0/main.md` tracks the proposed multi-language release phases; keep its status synchronized with the phase documents during implementation.

## Build, Test, and Development Commands

Use Bun for dependencies, scripts, and temporary JavaScript commands. Makefile targets invoke npm; prefer these commands.

| Command | Purpose |
| --- | --- |
| `bun install` | Install dependencies. |
| `bun run dev` | Rebuild on source changes with tsup. |
| `bun run build` | Generate library and CLI bundles in `dist/`. |
| `bun run typecheck` | Check strict TypeScript without emitting files. |
| `bun run test` | Run Bun argument and disposable-repository release tests. |
| `bun run lint` | Run Biome lint rules on `src/`. |
| `bun run format` | Format `src/` with Biome. |
| `bun run check` | Apply Biome checks and formatting fixes to `src/`. |
| `node dist/cli.js --version` | Smoke-test the built CLI without starting a release. |

The published CLI requires Node.js 18 or newer. Release workflows also require Git and authenticated GitHub CLI (`gh auth login`).

## Coding Style & Naming Conventions

Use strict TypeScript and ESM with `.js` extensions in relative imports. Follow `biome.json`: two-space indentation, 100-column formatting, and recommended lint rules. Use double quotes and semicolons, camelCase functions and variables, PascalCase types, and kebab-case multiword filenames. Keep subprocess execution in existing helpers and validate branch names, tags, and paths before use.

## Testing Guidelines

Tests use Bun's built-in runner with `tests/*.test.ts`; no coverage threshold is configured. Before submitting, run tests, typecheck, lint, build, and the version smoke test. Validate release-flow changes in disposable repositories, including RC/final releases and relevant mono/meta scenarios; workflows can push branches, tags, and GitHub releases. Automated flow tests use local bare remotes with GitHub tag/release creation disabled.

## Commit & Pull Request Guidelines

Follow the history's Conventional Commit style: `feat:`, `fix:`, `docs:`, and `chore(release):`. Discuss significant changes in an issue first. PRs should describe behavior changes, link relevant issues, and record validation; include terminal output for changed prompts.

## Documentation Maintenance

Keep this guide and affected README sections synchronized with behavior, configuration, commands, and structure changes. Preserve unrelated user edits.
