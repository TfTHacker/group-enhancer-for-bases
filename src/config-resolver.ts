import { BaseGroupEnhancerConfig } from './base-config';

/**
 * Merged configuration from global plugin settings + base-level overrides.
 * Hierarchy (lowest to highest priority):
 * 1. Global plugin defaults
 * 2. Base-level defaults
 * 3. View-level overrides
 */
export interface ResolvedConfig {
	enableCollapsibleGroups: boolean;
	rememberFoldState: boolean;
	collapseAllByDefault: boolean;
	showToolbarButtons: boolean;
	toolbarButtonDisplay: 'icon' | 'text' | 'both';
	showGroupCounts: boolean;
}

/**
 * Resolves configuration by merging global settings with base-level config.
 */
export class ConfigResolver {
	/**
	 * Resolve final config by layering global -> base defaults -> view overrides.
	 * Global settings are the defaults. View overrides win.
	 */
	static resolve(
		globalSettings: ResolvedConfig,
		baseConfig: BaseGroupEnhancerConfig | undefined,
		activeViewName: string | undefined
	): ResolvedConfig {
		let resolved = { ...globalSettings };

		if (baseConfig) {
			// Apply base-level defaults if available
			if (baseConfig.defaults) {
				resolved = this._applyPartialConfig(resolved, baseConfig.defaults);
			}

			// Apply view-level overrides if available
			if (baseConfig.views && activeViewName) {
				const viewConfig = baseConfig.views[activeViewName];
				if (viewConfig) {
					resolved = this._applyPartialConfig(resolved, viewConfig);
				}
			}
		}

		return resolved;
	}

	/**
	 * Apply a partial config object, preserving unset values.
	 */
	private static _applyPartialConfig(
		base: ResolvedConfig,
		partial: Partial<ResolvedConfig>
	): ResolvedConfig {
		const result = { ...base };

		if (partial.enableCollapsibleGroups !== undefined) {
			result.enableCollapsibleGroups = partial.enableCollapsibleGroups;
		}
		if (partial.rememberFoldState !== undefined) {
			result.rememberFoldState = partial.rememberFoldState;
		}
		if (partial.collapseAllByDefault !== undefined) {
			result.collapseAllByDefault = partial.collapseAllByDefault;
		}
		if (partial.showToolbarButtons !== undefined) {
			result.showToolbarButtons = partial.showToolbarButtons;
		}
		if (partial.toolbarButtonDisplay !== undefined) {
			result.toolbarButtonDisplay = partial.toolbarButtonDisplay;
		}
		if (partial.showGroupCounts !== undefined) {
			result.showGroupCounts = partial.showGroupCounts;
		}

		return result;
	}

	/**
	 * Get the active view name from DOM context.
	 * Looks for view names in the Bases view structure.
	 */
	static getActiveViewName(): string | undefined {
		// Try to find the active bases-view
		const view = document.querySelector<HTMLElement>('.bases-view.is-grouped');
		if (!view) return undefined;

		// Look for view name in the DOM
		// Bases usually stores this in the view's context or as a data attribute
		const nameAttr = view.getAttribute('data-view-name');
		if (nameAttr) return nameAttr;

		// Check the first table's name if available
		const tableHeader = view.querySelector<HTMLElement>(
			'.bases-view-name, [data-testid="bases-view-name"]'
		);
		if (tableHeader?.textContent) {
			return tableHeader.textContent.trim();
		}

		// Last resort: try to get from any visible group headings' parent context
		const container = view.closest('.bases-table-container');
		if (container) {
			const meta = container.getAttribute('data-view');
			if (meta) return meta;
		}

		return undefined;
	}
}
