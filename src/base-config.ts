import { App, TFile } from 'obsidian';

/**
 * Per-base plugin configuration stored inside .base files.
 * Structured for safe preservation during Obsidian saves.
 */
export interface BaseGroupEnhancerConfig {
	defaults?: {
		enableCollapsibleGroups?: boolean;
		rememberFoldState?: boolean;
		collapseAllByDefault?: boolean;
		showToolbarButtons?: boolean;
		toolbarButtonDisplay?: 'icon' | 'text' | 'both';
		showGroupCounts?: boolean;
	};
	views?: Record<
		string,
		{
			enableCollapsibleGroups?: boolean;
			rememberFoldState?: boolean;
			collapseAllByDefault?: boolean;
			showToolbarButtons?: boolean;
			toolbarButtonDisplay?: 'icon' | 'text' | 'both';
			showGroupCounts?: boolean;
		}
	>;
}

export interface ParsedBaseFile {
	config?: BaseGroupEnhancerConfig;
	rawContent: string;
	hasGroupEnhancerSection: boolean;
}

/**
 * YAML-safe base file config manager.
 * Preserves all existing .base file content while reading/writing config.
 */
export class BaseConfigManager {
	constructor(private app: App) {}

	/**
	 * Find the .base file associated with an active view.
	 * Returns path like "folder/name.base"
	 */
	async findBaseFileForActiveView(): Promise<string | null> {
		const activeLeaf = this.app.workspace.activeLeaf;
		if (!activeLeaf) return null;

		const view = activeLeaf.view as {
			file?: TFile;
			title?: string;
			containerEl?: HTMLElement;
		};

		// Try to find .base file from view context
		if (view?.file?.path?.endsWith('.base')) {
			return view.file.path;
		}

		// Try to find by scanning the DOM for any base-table container
		// and its associated metadata
		const containerEl = (activeLeaf as any).containerEl as HTMLElement | undefined;
		const container = containerEl?.querySelector(
			'.bases-view[data-bases-file]'
		) as HTMLElement | null;
		if (container) {
			const basePath = container.getAttribute('data-bases-file');
			if (basePath) return basePath;
		}

		// Last resort: search for .base files in the vault
		const basesFolder = this.app.vault.getAbstractFileByPath('Bases');
		if (!basesFolder || !(basesFolder as any).children) return null;

		// This is expensive, only do as fallback
		const allBaseFiles: TFile[] = [];
		const collect = (f: any) => {
			if (f.children) f.children.forEach(collect);
			if (f.path?.endsWith('.base')) allBaseFiles.push(f);
		};
		collect(basesFolder);

		// Pick the first one as a last resort (not ideal but safe fallback)
		return allBaseFiles.length > 0 ? allBaseFiles[0].path : null;
	}

	/**
	 * Read and parse a .base file's groupEnhancer config.
	 * Safely handles missing config sections.
	 */
	async readBaseConfig(baseFilePath: string): Promise<ParsedBaseFile> {
		try {
			const file = this.app.vault.getAbstractFileByPath(baseFilePath);
			if (!file || !(file instanceof TFile)) {
				return {
					rawContent: '',
					hasGroupEnhancerSection: false,
					config: undefined,
				};
			}

			const content = await this.app.vault.read(file);

			// Parse YAML manually to extract groupEnhancer section
			const config = this._parseGroupEnhancerConfig(content);
			const hasSection = content.includes('groupEnhancer:');

			return {
				rawContent: content,
				hasGroupEnhancerSection: hasSection,
				config,
			};
		} catch (error) {
			console.error(`[CGBConfig] Failed to read base file ${baseFilePath}:`, error);
			return {
				rawContent: '',
				hasGroupEnhancerSection: false,
				config: undefined,
			};
		}
	}

	/**
	 * Write groupEnhancer config back to a .base file.
	 * Preserves all other file content using line-by-line merging.
	 */
	async writeBaseConfig(
		baseFilePath: string,
		config: BaseGroupEnhancerConfig
	): Promise<boolean> {
		try {
			const file = this.app.vault.getAbstractFileByPath(baseFilePath);
			if (!file || !(file instanceof TFile)) {
				console.warn(
					`[CGBConfig] Could not find base file at ${baseFilePath}`
				);
				return false;
			}

			const currentContent = await this.app.vault.read(file);
			const newContent = this._mergeConfigIntoYaml(
				currentContent,
				config
			);

			if (newContent === currentContent) {
				// No change needed
				return true;
			}

			// Write back atomically
			await this.app.vault.modify(file, newContent);
			return true;
		} catch (error) {
			console.error(
				`[CGBConfig] Failed to write base file ${baseFilePath}:`,
				error
			);
			return false;
		}
	}

	/**
	 * Parse groupEnhancer config from YAML content.
	 * Handles missing/malformed YAML gracefully.
	 */
	private _parseGroupEnhancerConfig(
		yamlContent: string
	): BaseGroupEnhancerConfig | undefined {
		const lines = yamlContent.split('\n');
		let inGroupEnhancer = false;
		let inDefaults = false;
		let inViews = false;
		let currentViewName = '';
		const configLines: string[] = [];
		let indent = 0;

		for (const line of lines) {
			const trimmed = line.trim();
			const lineIndent = line.length - line.trimStart().length;

			// Detect groupEnhancer section start
			if (trimmed.startsWith('groupEnhancer:')) {
				inGroupEnhancer = true;
				indent = lineIndent;
				configLines.push(line);
				continue;
			}

			// Exit groupEnhancer section if we hit a non-nested key at same/lower indent
			if (inGroupEnhancer && lineIndent <= indent && trimmed.length > 0) {
				break;
			}

			if (inGroupEnhancer) {
				configLines.push(line);
				// Track subsections
				if (trimmed.startsWith('defaults:')) {
					inDefaults = true;
					inViews = false;
				} else if (trimmed.startsWith('views:')) {
					inDefaults = false;
					inViews = true;
				} else if (
					inViews &&
					!trimmed.startsWith('-') &&
					lineIndent === indent + 2 &&
					trimmed.includes(':')
				) {
					currentViewName = trimmed.split(':')[0].trim();
				}
			}
		}

		if (!inGroupEnhancer) return undefined;

		// Safely parse the extracted YAML
		return this._parseYamlBlock(configLines.join('\n'));
	}

	/**
	 * Parse a YAML block into a config object.
	 * Handles nested structures with proper indentation.
	 */
	private _parseYamlBlock(yamlText: string): BaseGroupEnhancerConfig {
		const config: BaseGroupEnhancerConfig = {};
		const lines = yamlText.split('\n');

		let currentSection = '';
		let currentView = '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			const indent = line.length - line.trimStart().length;

			if (trimmed === 'groupEnhancer:') continue;

			if (trimmed === 'defaults:') {
				currentSection = 'defaults';
				if (!config.defaults) config.defaults = {};
				continue;
			}

			if (trimmed === 'views:') {
				currentSection = 'views';
				if (!config.views) config.views = {};
				continue;
			}

			// Parse key-value pairs
			if (trimmed.includes(':')) {
				const [key, value] = trimmed.split(':').map((s) => s.trim());

				if (currentSection === 'defaults' && config.defaults) {
					const parsed = this._parseValue(value);
					(config.defaults as any)[key] = parsed;
				} else if (currentSection === 'views') {
					// View names don't have values after colon
					if (!value || value === '') {
						currentView = key;
						if (!config.views) config.views = {};
						config.views[key] = {};
					} else if (config.views?.[currentView]) {
						const parsed = this._parseValue(value);
						(config.views[currentView] as any)[key] = parsed;
					}
				}
			}
		}

		return config;
	}

	/**
	 * Parse a YAML value into its proper type (boolean, string, etc).
	 */
	private _parseValue(value: string): any {
		if (value === 'true') return true;
		if (value === 'false') return false;
		if (!isNaN(Number(value))) return Number(value);
		return value || undefined;
	}

	/**
	 * Merge config into YAML content while preserving all other structure.
	 * Uses line-by-line merging to handle arbitrary YAML layouts.
	 */
	private _mergeConfigIntoYaml(
		originalYaml: string,
		config: BaseGroupEnhancerConfig
	): string {
		const lines = originalYaml.split('\n');
		const result: string[] = [];

		let foundGroupEnhancer = false;
		let groupEnhancerStartIdx = -1;
		let groupEnhancerEndIdx = -1;
		let groupEnhancerIndent = 0;

		// Find groupEnhancer section bounds
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			const indent = line.length - line.trimStart().length;

			if (trimmed.startsWith('groupEnhancer:') && !foundGroupEnhancer) {
				foundGroupEnhancer = true;
				groupEnhancerStartIdx = i;
				groupEnhancerIndent = indent;
				continue;
			}

			if (foundGroupEnhancer && groupEnhancerEndIdx === -1) {
				// Check if we've exited the groupEnhancer section
				if (
					trimmed.length > 0 &&
					indent <= groupEnhancerIndent &&
					!trimmed.startsWith('#')
				) {
					groupEnhancerEndIdx = i;
					continue;
				}
			}
		}

		if (!foundGroupEnhancer) {
			// No existing groupEnhancer section, add it at the end
			return originalYaml + (originalYaml.endsWith('\n') ? '' : '\n') +
				this._serializeConfig(config, 0);
		}

		// Replace the groupEnhancer section
		const before = lines.slice(0, groupEnhancerStartIdx);
		const after = lines.slice(groupEnhancerEndIdx === -1 ? lines.length : groupEnhancerEndIdx);

		result.push(...before);
		result.push(this._serializeConfig(config, groupEnhancerIndent));
		result.push(...after);

		return result.join('\n').replace(/\n\n\n+/g, '\n\n').trim() + '\n';
	}

	/**
	 * Serialize config object to YAML with proper indentation.
	 */
	private _serializeConfig(config: BaseGroupEnhancerConfig, baseIndent: number): string {
		const lines: string[] = [];
		const indent = (n: number) => ' '.repeat(baseIndent + n);

		lines.push(indent(0) + 'groupEnhancer:');

		if (config.defaults) {
			lines.push(indent(2) + 'defaults:');
			for (const [key, value] of Object.entries(config.defaults)) {
				if (value !== undefined) {
					lines.push(indent(4) + `${key}: ${this._serializeValue(value)}`);
				}
			}
		}

		if (config.views && Object.keys(config.views).length > 0) {
			lines.push(indent(2) + 'views:');
			for (const [viewName, viewConfig] of Object.entries(config.views)) {
				lines.push(indent(4) + `${viewName}:`);
				for (const [key, value] of Object.entries(viewConfig)) {
					if (value !== undefined) {
						lines.push(indent(6) + `${key}: ${this._serializeValue(value)}`);
					}
				}
			}
		}

		return lines.join('\n');
	}

	/**
	 * Serialize a single value to YAML format.
	 */
	private _serializeValue(value: any): string {
		if (typeof value === 'boolean') return value ? 'true' : 'false';
		if (typeof value === 'number') return String(value);
		return String(value);
	}
}
