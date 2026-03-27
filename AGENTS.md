# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the plugin source. [`src/main.ts`](/srv/shared_data/dev/group-enhancer-for-bases/src/main.ts) is the Obsidian entry point, while [`src/base-config.ts`](/srv/shared_data/dev/group-enhancer-for-bases/src/base-config.ts) and [`src/config-resolver.ts`](/srv/shared_data/dev/group-enhancer-for-bases/src/config-resolver.ts) handle `.base` file parsing and settings resolution. Build output is `main.js` at the repository root. Metadata lives in `manifest.json` and `versions.json`. Static assets, including screenshots, are under `assets/`.

## Build, Test, and Development Commands
Run `npm install` once to install TypeScript and bundling dependencies.

- `npm run dev`: builds with inline sourcemaps for local iteration.
- `npm run build`: runs `node node_modules/typescript/lib/tsc.js -noEmit -skipLibCheck` and then produces the production bundle.
- `npm run version`: bumps `manifest.json` and `versions.json` for a release-ready version update.

There is no dedicated test runner configured today, so `npm run build` is the main verification step.

## Coding Style & Naming Conventions
The codebase uses TypeScript with tabs for indentation and single quotes in source files. Follow the existing naming patterns: PascalCase for classes and interfaces (`BaseConfigManager`), camelCase for functions and variables, and leading underscores for internal plugin methods and fields (`_loadBaseConfig`, `_foldState`). Keep modules small and focused on one concern. Prefer explicit types when interacting with Obsidian internals or DOM-derived data.

## Testing Guidelines
No automated tests are checked in yet. For each change, run `npm run build` and manually verify behavior in Obsidian against a grouped Bases view. Test both global settings and `.base`-level overrides when touching configuration logic. If you add tests later, place them near the source they cover or under a new `test/` directory and name them after the module under test.

## Commit & Pull Request Guidelines
The current history uses short, imperative commit subjects such as `Initial distribution-ready snapshot`. Keep commits focused and descriptive, for example `Add view-level toolbar toggle`. Pull requests should include a brief summary, manual verification notes, linked issues when applicable, and updated screenshots when UI behavior changes.

## Release & Configuration Notes
Treat `manifest.json`, `versions.json`, and `main.js` as release artifacts that must stay in sync. Changes to `.base` parsing should preserve existing user content and fail safely when metadata is missing or malformed.

GitHub Releases are created by [`.github/workflows/release.yml`](/srv/shared_data/dev/group-enhancer-for-bases/.github/workflows/release.yml) when a plain `x.y.z` tag is pushed. The verified release flow for this repo is:

1. Ensure the working tree is clean with `git status`.
2. If `git push origin main` would be non-fast-forward, run `git fetch origin` and `git rebase origin/main` first. If conflicts occur, resolve them, `git add` the resolved files, and continue with `GIT_EDITOR=true git rebase --continue`.
3. Run `npm version patch` or `npm version minor` or `npm version major`.
4. Verify `package.json`, `manifest.json`, and `versions.json` all have the same version.
5. Important: `npm version` currently creates a `vX.Y.Z` tag by default, but the workflow only matches plain `X.Y.Z`. Replace the tag before pushing, for example `git tag -d v0.1.1 && git tag 0.1.1 HEAD`.
6. Push the branch with `git push origin main`.
7. Push the plain release tag with `git push origin 0.1.1`.

The release workflow publishes `main.js`, `manifest.json`, and `styles.css`. Do not push a `v`-prefixed tag for releases unless the workflow is updated to accept it.
