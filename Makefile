# github-deploy-pipeline — development & publishing commands
.PHONY: \
	help build dev clean typecheck lint format check \
	publish publish-dry version-patch version-minor version-major \
	install release-patch release-minor release-major

BLUE  := $(shell printf '\033[34m')
GREEN := $(shell printf '\033[32m')
YELLOW:= $(shell printf '\033[33m')
RESET := $(shell printf '\033[0m')

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

.DEFAULT_GOAL := help

help:
	@echo ""
	@echo "$(BLUE)github-deploy-pipeline$(RESET)"
	@echo ""
	@echo "$(BLUE)Development$(RESET)"
	@echo "  $(GREEN)install$(RESET)          npm install"
	@echo "  $(GREEN)build$(RESET)            compile TypeScript → dist/ via tsup"
	@echo "  $(GREEN)dev$(RESET)              watch mode (tsup --watch)"
	@echo "  $(GREEN)clean$(RESET)            remove dist/"
	@echo "  $(GREEN)typecheck$(RESET)        tsc --noEmit"
	@echo "  $(GREEN)lint$(RESET)             biome lint"
	@echo "  $(GREEN)format$(RESET)           biome format --write"
	@echo "  $(GREEN)check$(RESET)            biome check --write"
	@echo ""
	@echo "$(BLUE)Versioning$(RESET)"
	@echo "  $(GREEN)version-patch$(RESET)    bump patch version (e.g. 0.1.0 → 0.1.1)"
	@echo "  $(GREEN)version-minor$(RESET)    bump minor version (e.g. 0.1.0 → 0.2.0)"
	@echo "  $(GREEN)version-major$(RESET)    bump major version (e.g. 0.1.0 → 1.0.0)"
	@echo ""
	@echo "$(BLUE)Publishing$(RESET)"
	@echo "  $(GREEN)publish-dry$(RESET)      npm publish --dry-run (preview what will be published)"
	@echo "  $(GREEN)publish$(RESET)          build + npm publish"
	@echo ""
	@echo "$(BLUE)Release shortcuts$(RESET) (version bump + build + publish in one step)"
	@echo "  $(GREEN)release-patch$(RESET)    patch bump → build → publish"
	@echo "  $(GREEN)release-minor$(RESET)    minor bump → build → publish"
	@echo "  $(GREEN)release-major$(RESET)    major bump → build → publish"
	@echo ""

install:
	npm install

build:
	npm run build

dev:
	npm run dev

clean:
	rm -rf dist

typecheck:
	npm run typecheck

lint:
	npm run lint

format:
	npm run format

check:
	npm run check

version-patch:
	npm version patch --no-git-tag-version
	@echo "$(GREEN)Patch version bumped. Commit and tag manually, or use make release-patch.$(RESET)"

version-minor:
	npm version minor --no-git-tag-version
	@echo "$(GREEN)Minor version bumped. Commit and tag manually, or use make release-minor.$(RESET)"

version-major:
	npm version major --no-git-tag-version
	@echo "$(GREEN)Major version bumped. Commit and tag manually, or use make release-major.$(RESET)"

publish-dry: build
	npm publish --dry-run --access public

publish: build
	npm publish --access public

release-patch:
	npm version patch
	$(MAKE) publish

release-minor:
	npm version minor
	$(MAKE) publish

release-major:
	npm version major
	$(MAKE) publish
