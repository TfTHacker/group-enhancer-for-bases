# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the plugin source. [`src/main.ts`](/srv/shared_data/dev/group-enhancer-for-bases/src/main.ts) is the Obsidian entry point, while [`src/base-config.ts`](/srv/shared_data/dev/group-enhancer-for-bases/src/base-config.ts) and [`src/config-resolver.ts`](/srv/shared_data/dev/group-enhancer-for-bases/src/config-resolver.ts) handle `.base` file parsing and settings resolution. Build output is `main.js` at the repository root. Metadata lives in `manifest.json` and `versions.json`. Static assets, including screenshots, are under `assets/`.

## Build, Test, and Development Commands
Run `npm install` once to install TypeScript and bundling dependencies.

- `npm run dev`: builds with inline sourcemaps for local iteration.
- `npm run build`: runs `tsc -noEmit -skipLibCheck` and then produces the production bundle.
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
