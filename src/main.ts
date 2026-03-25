import { App, Plugin, PluginSettingTab, Setting, setIcon } from 'obsidian';
import { BaseConfigManager, BaseGroupEnhancerConfig } from './base-config';
import { ConfigResolver, ResolvedConfig } from './config-resolver';

interface CgbSettings {
	enableCollapsibleGroups: boolean;
	rememberFoldState: boolean;
	collapseAllByDefault: boolean;
	showToolbarButtons: boolean;
	toolbarButtonDisplay: 'icon' | 'text' | 'both';
	showGroupCounts: boolean;
}

const DEFAULT_SETTINGS: CgbSettings = {
	enableCollapsibleGroups: true,
	rememberFoldState: true,
	collapseAllByDefault: false,
	showToolbarButtons: true,
	toolbarButtonDisplay: 'both',
	showGroupCounts: true,
};

type BasesGroup = {
	key?: { toString?: () => string; renderTo?: (el: HTMLElement, ctx: unknown) => void };
	entries: unknown[];
	tableEl?: HTMLElement;
	tbodyEl?: HTMLElement;
	summaryRow?: { shouldDisplay?: () => boolean; el?: HTMLElement };
};

type BasesData = {
	groupedDataCache?: BasesGroup[] | null;
	groupedData?: BasesGroup[];
};

type BasesTableView = {
	config?: { get?: (key: string) => unknown; groupBy?: { property?: string } };
	data?: BasesData;
	groups?: BasesGroup[];
	scrollEl?: HTMLElement;
	containerEl?: HTMLElement;
	display?: () => void;
	updateVirtualDisplay?: () => void;
	lastViewport?: { left: number; right: number; top: number; bottom: number };
	createGroupHeadingEl?: (group: BasesGroup) => HTMLElement | null;
	__cgbOriginalGroupedData?: BasesGroup[];
	__cgbGroupCountMap?: Record<string, number>;
	__cgbGapFixerInstalled?: boolean;
};

export default class CollapsibleGroupsPlugin extends Plugin {
	settings: CgbSettings = DEFAULT_SETTINGS;
	private _foldState: Record<string, boolean> = {};
	private _collapsedKeys: Set<string> = new Set();
	private _observer: MutationObserver | null = null;
	private _embedObserver: MutationObserver | null = null;
	private _embedVisibilityObservers: IntersectionObserver[] = [];
	private _patchTimer: ReturnType<typeof setTimeout> | null = null;
	private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private _rerenderingEmbed: boolean = false;
	private _styleEl: HTMLStyleElement | null = null;
	private _boundPointerUp?: (e: PointerEvent) => void;
	private _patchedHeaders: WeakSet<HTMLElement> = new WeakSet();
	private _lastHeaderCount: number = 0;
	private _headerKeyCache: Map<HTMLElement, string> = new Map();

	// Base config management
	private _baseConfigManager: BaseConfigManager | null = null;
	private _currentBaseConfig: BaseGroupEnhancerConfig | null = null;
	private _currentBaseFile: string | null = null;
	private _currentViewName: string | null = null;
	private _cachedResolvedSettings: ResolvedConfig | null = null;
	private _baseConfigCacheDirty: boolean = true;

	async onload() {
		await this.loadSettings();
		await this._loadFoldState();
		for (const key of Object.keys(this._foldState)) this._collapsedKeys.add(key);

		// Initialize base config manager
		this._baseConfigManager = new BaseConfigManager(this.app);

		this.addSettingTab(new CgbSettingTab(this.app, this));
		this._injectStyles();
		this._bindDelegatedEvents();
		this.addCommand({
			id: 'collapse-all-groups',
			name: 'Collapse all groups in current Bases view',
			checkCallback: (checking: boolean) => {
				const resolved = this._getResolvedSettings();
				const ok = resolved.enableCollapsibleGroups && !!this._getActiveTableView();
				if (!checking && ok) this._collapseAll();
				return ok;
			},
		});
		this.addCommand({
			id: 'expand-all-groups',
			name: 'Expand all groups in current Bases view',
			checkCallback: (checking: boolean) => {
				const resolved = this._getResolvedSettings();
				const ok = resolved.enableCollapsibleGroups && !!this._getActiveTableView();
				if (!checking && ok) this._expandAll();
				return ok;
			},
		});



		this.app.workspace.onLayoutReady(() => {
			// Clear stale per-element flags from previous plugin loads
			document.querySelectorAll('.internal-embed.bases-embed').forEach(el => {
				delete (el as HTMLElement & { __cgbModelApplied?: boolean }).__cgbModelApplied;
				delete (el as HTMLElement & { __cgbVisibilityWatched?: boolean }).__cgbVisibilityWatched;
			});
			this._refreshAllGroupedViews();
		});

		// Listen for view opens to refresh when switching to grouped views
		// Hide the active grouped view immediately, then restore after config/state is applied.
		this.app.workspace.on('active-leaf-change', () => {
			if (this._patchTimer) clearTimeout(this._patchTimer);
			if (this._refreshTimer) clearTimeout(this._refreshTimer);
			this._setInitializingState(true);
			this._patchTimer = setTimeout(async () => {
				await this._loadBaseConfig();
				if (this._getActiveTableView()) {
					this._refreshAllGroupedViews();
				} else {
					this._setInitializingState(false);
					// Clear per-embed flags so fresh patching runs on this leaf
					const leaf = this.app.workspace.activeLeaf;
					leaf?.view?.containerEl?.querySelectorAll('.internal-embed.bases-embed').forEach(el => {
						delete (el as HTMLElement & { __cgbModelApplied?: boolean }).__cgbModelApplied;
						delete (el as HTMLElement & { __cgbVisibilityWatched?: boolean }).__cgbVisibilityWatched;
					});
					// May be a markdown leaf with embedded bases — patch those
					this._refreshEmbeddedInActiveLeaf();
					// May be a canvas leaf with embedded bases — patch those
					this._refreshCanvasLeaf();
					// Set up scroll listener to catch embeds created by CM virtualization
					this._setupScrollPatch();
				}
			}, 120);
		});

		// Watch for embedded bases appearing in the DOM
		this._setupEmbedObserver();
	}

	private _scrollPatchHandler: (() => void) | null = null;
	private _scrollPatchScroller: HTMLElement | null = null;

	private _setupScrollPatch() {
		// Remove previous scroll listener if any
		if (this._scrollPatchHandler && this._scrollPatchScroller) {
			this._scrollPatchScroller.removeEventListener('scroll', this._scrollPatchHandler);
			this._scrollPatchHandler = null;
			this._scrollPatchScroller = null;
		}

		const leaf = this.app.workspace.activeLeaf;
		if (!leaf) return;
		if (leaf.view?.getViewType() !== 'markdown') return;

		const scroller = leaf.view.containerEl?.querySelector<HTMLElement>('.cm-scroller');
		if (!scroller) return;

		let ticking = false;
		let scrollTimer: ReturnType<typeof setTimeout> | null = null;
		const handler = () => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(() => {
				ticking = false;
				// Debounce: only fire 300ms after scrolling stops.
				// This avoids calling _applyCollapsedModelToEmbed multiple times during a
				// single scroll gesture as CM virtualizes the embed into view.
				if (scrollTimer) clearTimeout(scrollTimer);
				scrollTimer = setTimeout(() => {
					scrollTimer = null;
					this._refreshEmbeddedInActiveLeaf();
				}, 300);
			});
		};

		scroller.addEventListener('scroll', handler, { passive: true });
		this._scrollPatchHandler = handler;
		this._scrollPatchScroller = scroller;
	}

	private _setupEmbedObserver() {
		if (this._embedObserver) return;
		this._embedObserver = new MutationObserver((mutations) => {
			let hasNewGroupedView = false;
			let hasNewEmbed = false;
			for (const mutation of mutations) {
				// Watch for class changes (is-grouped being added to a bases-view)
				if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
					const el = mutation.target as HTMLElement;
					if (el.classList?.contains('bases-view') && el.classList?.contains('is-grouped')) {
						hasNewGroupedView = true;
					}
				}
				// Watch for new DOM nodes containing grouped bases
				const nodes = Array.from(mutation.addedNodes);
				for (const node of nodes) {
					if (node.nodeType !== 1) continue;
					const el = node as HTMLElement;
					if (el.classList?.contains('bases-view') ||
						el.classList?.contains('bases-embed') ||
						el.classList?.contains('internal-embed') ||
						el.querySelector?.('.bases-view.is-grouped') ||
						el.querySelector?.('.bases-embed') ||
						el.querySelector?.('.internal-embed.bases-embed')) {
						const isEmbed = el.closest?.('.internal-embed') || el.classList?.contains('bases-embed') || el.classList?.contains('internal-embed') || !!el.querySelector?.('.internal-embed');
						isEmbed ? hasNewEmbed = true : hasNewGroupedView = true;
					}
					// Unpatched group headings added — patch them immediately
					if (el.classList?.contains('bases-group-heading') && !el.hasAttribute('data-cgb-patched')) {
						hasNewGroupedView = true;
					}
					const innerHeadings = el.querySelectorAll?.('.bases-group-heading:not([data-cgb-patched])');
					if (innerHeadings?.length) hasNewGroupedView = true;
				}
			}
			if (hasNewGroupedView) {
				if (this._refreshTimer) clearTimeout(this._refreshTimer);
				this._refreshTimer = setTimeout(() => {
					if (this._getActiveTableView()) {
						this._refreshAllGroupedViews();
					} else {
						// Canvas or other view with embedded grouped bases
						this._patchToolbars();
						this._patchHeaders();
					}
				}, 100);
			}
			if (hasNewEmbed) {
				if (this._refreshTimer) clearTimeout(this._refreshTimer);
				this._refreshTimer = setTimeout(() => {
					this._refreshEmbeddedInActiveLeaf();
				}, 150);
			}
		});
		this._embedObserver.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['class'],
		});
	}

	private _refreshCanvasLeaf() {
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf) return;
		if (leaf.view?.getViewType() !== 'canvas') return;
		this._patchToolbars();
		this._patchHeaders();
		// Find all canvas nodes with Bases embeds and apply collapse state
		const canvasNodeEls = leaf.view.containerEl.querySelectorAll<HTMLElement>('.canvas-node');
		canvasNodeEls.forEach(el => {
			if (el.querySelector('.bases-view.is-grouped')) {
				this._applyCanvasNodeCollapse(el);
			}
		});
	}

	private _refreshEmbeddedInActiveLeaf() {
		if (this._rerenderingEmbed) return;
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf) return;
		const container = leaf.view?.containerEl as HTMLElement | undefined;
		if (!container) return;
		const embedEls = container.querySelectorAll<HTMLElement>('.internal-embed.bases-embed');
		if (!embedEls.length) return;
		// Patch toolbars for all grouped views in document (covers embeds too)
		this._patchToolbars();
		embedEls.forEach(embedEl => {
			this._patchEmbedHeaders(embedEl);
			this._applyEmbedCollapse(embedEl);
			// Watch for embed scrolling into view so Bases can render all rows
			this._watchEmbedVisibility(embedEl);
			// Apply data model if not yet done for this embed instance.
			// Use a flag rather than header-patched check to avoid race conditions.
			const notYetInitialized = !(embedEl as HTMLElement & { __cgbModelApplied?: boolean }).__cgbModelApplied;
			if (notYetInitialized && !this._rerenderingEmbed) {
				(embedEl as HTMLElement & { __cgbModelApplied?: boolean }).__cgbModelApplied = true;
				this._applyCollapsedModelToEmbed(embedEl);
			}
		});
	}

	/**
	 * On initial embed load, if any expanded groups would be hidden off-screen due to
	 * Bases' virtual positioning, collapse all groups so all headers are visible.
	 * A group is "off-screen" if its table has top > 0 and no data-cgb-collapsed attribute.
	 */
	private _autoCollapseEmbedIfNeeded(embedEl: HTMLElement) {
		const resolved = this._getResolvedSettings();
		if (!resolved.enableCollapsibleGroups) return;
		const src = embedEl.getAttribute('src') ?? '';
		const tables = embedEl.querySelectorAll<HTMLElement>('.bases-table');
		let hasExpandedOffscreen = false;
		for (let i = 0; i < tables.length; i++) {
			const t = tables[i];
			const top = parseInt(t.style.top || '0', 10);
			const alreadyCollapsed = t.getAttribute('data-cgb-collapsed') === 'true';
			const heading = t.querySelector('.bases-group-value')?.textContent?.trim();
			const key = `${src}::${this._normalizeGroupValue(heading)}`;
			const inCollapsedKeys = this._collapsedKeys.has(key) || resolved.collapseAllByDefault;
			// If this group is not collapsed by saved state but has top > 0, it's off-screen
			if (!inCollapsedKeys && !alreadyCollapsed && top > 0) {
				hasExpandedOffscreen = true;
				break;
			}
		}
		if (!hasExpandedOffscreen) return;
		// Collapse all groups for this embed
		for (let i = 0; i < tables.length; i++) {
			const heading = tables[i].querySelector('.bases-group-value')?.textContent?.trim();
			const key = `${src}::${this._normalizeGroupValue(heading)}`;
			this._collapsedKeys.add(key);
		}
		// Persist new keys to fold state
		if (resolved.rememberFoldState) {
			for (let i = 0; i < tables.length; i++) {
				const heading = tables[i].querySelector('.bases-group-value')?.textContent?.trim();
				const key = `${src}::${this._normalizeGroupValue(heading)}`;
				this._foldState[key] = true;
			}
			this._saveFoldState();
		}
	}

	private _patchEmbedHeaders(embedEl: HTMLElement) {
		const headers = embedEl.querySelectorAll<HTMLElement>('.bases-group-heading');
		headers.forEach(h => this._patchHeader(h));
	}

	/**
	 * Get resolved config that merges global settings with base-level config.
	 * Cached for performance; invalidated when base config or global settings change.
	 */
	private _getResolvedSettings(): ResolvedConfig {
		if (!this._baseConfigCacheDirty && this._cachedResolvedSettings) {
			return this._cachedResolvedSettings;
		}

		const resolved = ConfigResolver.resolve(
			this.settings,
			this._currentBaseConfig ?? undefined,
			this._currentViewName ?? undefined
		);

		this._cachedResolvedSettings = resolved;
		this._baseConfigCacheDirty = false;
		return resolved;
	}

	/**
	 * Load base config for the currently active grouped view.
	 * Called when switching views or loading the plugin.
	 */
	private async _loadBaseConfig(): Promise<void> {
		if (!this._baseConfigManager) return;

		try {
			const baseFile = await this._baseConfigManager.findBaseFileForActiveView();
			if (!baseFile) {
				// No base file found, clear base config
				this._currentBaseConfig = null;
				this._currentBaseFile = null;
				this._currentViewName = null;
				this._baseConfigCacheDirty = true;
				return;
			}

			// Only reload if we switched to a different base file
			if (baseFile !== this._currentBaseFile) {
				this._currentBaseFile = baseFile;
				const parsed = await this._baseConfigManager.readBaseConfig(baseFile);
				this._currentBaseConfig = parsed.config ?? null;
				this._baseConfigCacheDirty = true;
			}

			// Always update view name
			const prevViewName = this._currentViewName;
			this._currentViewName = ConfigResolver.getActiveViewName() ?? null;
			if (prevViewName !== this._currentViewName) {
				this._baseConfigCacheDirty = true;
			}
		} catch (error) {
			console.error('[CGBBaseConfig] Failed to load base config:', error);
			this._currentBaseConfig = null;
			this._baseConfigCacheDirty = true;
		}
	}

	onunload() {
		this._observer?.disconnect();
		this._embedObserver?.disconnect();
		this._embedVisibilityObservers.forEach(io => io.disconnect());
		this._embedVisibilityObservers = [];
		if (this._scrollPatchHandler && this._scrollPatchScroller) {
			this._scrollPatchScroller.removeEventListener('scroll', this._scrollPatchHandler);
		}
		if (this._patchTimer) clearTimeout(this._patchTimer);
		if (this._refreshTimer) clearTimeout(this._refreshTimer);
		if (this._boundPointerUp) document.removeEventListener('pointerup', this._boundPointerUp, true);
		this._styleEl?.remove();
		this._headerKeyCache.clear();
		document.querySelectorAll('.cgb-toolbar, .cgb-chevron, .cgb-count-badge').forEach(el => el.remove());
		document.querySelectorAll('[data-cgb-patched],[data-cgb-container-patched]').forEach(el => {
			el.removeAttribute('data-cgb-patched');
			el.removeAttribute('data-cgb-container-patched');
		});
		this._resetGroupedDataCache();
		this._displayActiveTable();
	}

	private _injectStyles() {
		this._styleEl = document.createElement('style');
		this._styleEl.id = 'cgb-styles';
		this._styleEl.textContent = `
.cgb-chevron {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 30px; margin-right: 0; margin-left: -2px; flex-shrink: 0;
  transition: transform 150ms ease; opacity: 0.7;
  pointer-events: none;
}
.cgb-chevron svg, .cgb-chevron polyline { pointer-events: none; }
.bases-group-heading[data-cgb-patched] { user-select: none; padding-left: 0; }
.bases-group-heading[data-cgb-patched]:hover .cgb-chevron { opacity: 1; }
.cgb-chevron.is-collapsed { transform: rotate(-90deg); }
.cgb-toolbar {
  display: flex; gap: 6px; padding: 4px 8px;
  justify-content: flex-end; align-items: center;
  border-bottom: 1px solid var(--background-modifier-border);
}
.cgb-toolbar-btn {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: var(--font-ui-smaller); color: var(--text-muted);
  background: none; border: 1px solid var(--background-modifier-border);
  border-radius: var(--radius-s); padding: 2px 8px; cursor: pointer; line-height: 1.4;
}
.cgb-toolbar-btn:hover { color: var(--text-normal); background: var(--background-modifier-hover); }
.cgb-toolbar-btn-icon { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; }
.cgb-toolbar-btn.is-icon-only { padding: 4px 6px; gap: 0; }
.cgb-count-badge { font-size: var(--font-ui-smaller); color: var(--text-muted); margin-left: 6px; }
.bases-view.is-grouped[data-cgb-initializing="true"] { visibility: hidden; }
.internal-embed .bases-view.is-grouped .bases-table[data-cgb-collapsed="true"] > .bases-tbody { display: none !important; }
.internal-embed .bases-view.is-grouped .bases-table-container { overflow: visible !important; }
.canvas-node-content .bases-view.is-grouped .bases-table-container { height: auto !important; }
.canvas-node-content .bases-view.is-grouped .bases-table[data-cgb-collapsed="true"] > .bases-tbody { display: none !important; }
`;
		document.head.appendChild(this._styleEl);
	}

	private _bindDelegatedEvents() {
		this._boundPointerUp = (e: PointerEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			const header = target.closest('.bases-group-heading[data-cgb-patched]') as HTMLElement | null;
			if (!header) return;
			// Only bail if the interactive element is INSIDE the header (not an ancestor like CM6 contenteditable)
			const blocker = target.closest('button, a, input, [contenteditable]') as HTMLElement | null;
			if (blocker && header.contains(blocker)) return;
			e.preventDefault();
			e.stopPropagation();

			// Immediate visual feedback
			requestAnimationFrame(() => {
				this._toggle(header);
			});
		};
		document.addEventListener('pointerup', this._boundPointerUp, true);
	}

	private _observeLegacy() {
		// Observe active leaf changes to re-patch when switching to grouped views
		this.app.workspace.on('active-leaf-change', () => {
			if (this._patchTimer) clearTimeout(this._patchTimer);
			this._patchTimer = setTimeout(() => {
				if (this._getActiveTableView()) {
					this._refreshAllGroupedViews();
				}
			}, 100);
		});
	}

	private _refreshAllGroupedViews() {
		this._setInitializingState(true);
		requestAnimationFrame(() => {
			this._cleanupOrphanedElements();
			this._applyCollapsedModelToActiveTable();
			this._patchToolbars();
			this._patchHeaders();
			requestAnimationFrame(() => {
				this._setInitializingState(false);
			});
		});
	}

	private _setInitializingState(initializing: boolean) {
		const activeTable = this._getActiveTableView();
		let view = activeTable?.scrollEl as HTMLElement | undefined;
		if (!view?.classList.contains('bases-view')) {
			const container = this.app.workspace.activeLeaf?.view?.containerEl as HTMLElement | undefined;
			view = container?.querySelector('.bases-view.is-grouped') as HTMLElement | undefined;
		}
		if (!view?.classList.contains('bases-view')) return;
		if (initializing) view.setAttribute('data-cgb-initializing', 'true');
		else view.removeAttribute('data-cgb-initializing');
	}

	private _cleanupOrphanedElements() {
		// Remove all orphaned DOM elements that are not in the active view
		// Skip cleanup if no active table
		const activeTable = this._getActiveTableView();
		if (!activeTable?.scrollEl) return;

		const activeView = activeTable.scrollEl;
		const activeContainer = activeView.querySelector('.bases-table-container');
		if (!activeContainer) return;

		// Only check for orphaned elements if we have multiple bases-view containers
		const baseViews = document.querySelectorAll<HTMLElement>('.bases-view.is-grouped');
		if (baseViews.length <= 1) return; // Single view, no orphans possible from other views

		// Single query for all DOM elements that need checking
		const allOrphans = Array.from(document.querySelectorAll<HTMLElement>('.cgb-chevron, .cgb-count-badge'));

		// Batch removal in single pass
		const toRemove: HTMLElement[] = [];
		for (let i = 0; i < allOrphans.length; i++) {
			const el = allOrphans[i];
			// For chevrons/badges, check if header is still in the active container
			const header = el.closest('.bases-group-heading');
			if (!header || !activeContainer.contains(header)) {
				toRemove.push(el);
			}
		}

		// Remove all in batch
		for (let i = 0; i < toRemove.length; i++) {
			toRemove[i].remove();
		}
	}

	private _patchToolbars() {
		const resolved = this._getResolvedSettings();
		if (!resolved.showToolbarButtons) {
			document.querySelectorAll('.cgb-toolbar').forEach(el => el.remove());
			return;
		}
		if (!resolved.enableCollapsibleGroups) {
			document.querySelectorAll('.cgb-toolbar').forEach(el => el.remove());
			return;
		}

		const containers = document.querySelectorAll<HTMLElement>('.bases-view.is-grouped');
		for (let i = 0; i < containers.length; i++) {
			const container = containers[i];
			const parent = container.parentElement;
			if (!parent) continue;

			// Check if toolbar already exists for this container
			const existingToolbar = parent.querySelector('.cgb-toolbar');
			if (existingToolbar && container.hasAttribute('data-cgb-container-patched')) {
				continue;
			}

			// Create new toolbar in batch
			container.setAttribute('data-cgb-container-patched', 'true');
			const toolbar = document.createElement('div');
			toolbar.className = 'cgb-toolbar';

			const buttons: HTMLButtonElement[] = [];

			if (resolved.enableCollapsibleGroups) {
				const embedEl = container.closest('.internal-embed') as HTMLElement | null;
				const canvasNodeEl = container.closest('.canvas-node') as HTMLElement | null;
				if (embedEl) {
					buttons.push(this._createToolbarButton('Collapse all', 'fold-vertical', () => this._collapseAllInEmbed(embedEl)));
					buttons.push(this._createToolbarButton('Expand all', 'unfold-vertical', () => this._expandAllInEmbed(embedEl)));
				} else if (canvasNodeEl) {
					buttons.push(this._createToolbarButton('Collapse all', 'fold-vertical', () => this._collapseAllInCanvas(canvasNodeEl)));
					buttons.push(this._createToolbarButton('Expand all', 'unfold-vertical', () => this._expandAllInCanvas(canvasNodeEl)));
				} else {
					buttons.push(this._createToolbarButton('Collapse all', 'fold-vertical', () => this._collapseAll()));
					buttons.push(this._createToolbarButton('Expand all', 'unfold-vertical', () => this._expandAll()));
				}
			}

			// Batch append
			if (buttons.length > 0) {
				toolbar.append(...buttons);
				parent.insertBefore(toolbar, container);
			}
		}
	}

	private _createToolbarButton(label: string, icon: string, onClick: () => void): HTMLButtonElement {
		const resolved = this._getResolvedSettings();
		const btn = document.createElement('button');
		btn.className = 'cgb-toolbar-btn';
		btn.type = 'button';
		btn.setAttribute('aria-label', label);
		btn.setAttribute('title', label);
		const iconEl = document.createElement('span');
		iconEl.className = 'cgb-toolbar-btn-icon';
		setIcon(iconEl, icon);
		const textEl = document.createElement('span');
		textEl.textContent = label;

		switch (resolved.toolbarButtonDisplay) {
			case 'icon':
				btn.classList.add('is-icon-only');
				btn.appendChild(iconEl);
				break;
			case 'text':
				btn.appendChild(textEl);
				break;
			default:
				btn.append(iconEl, textEl);
				break;
		}

		btn.addEventListener('pointerdown', e => {
			e.stopPropagation(); // prevent canvas drag
		});
		btn.addEventListener('pointerup', e => {
			if ((e.target as HTMLElement).closest('button') !== btn) return;
			e.preventDefault();
			e.stopPropagation();
			onClick();
		});
		btn.addEventListener('click', e => {
			e.preventDefault();
			e.stopPropagation();
		});
		return btn;
	}

	private _patchHeaders() {
		// Patch all headers that are currently in the DOM
		const allHeaders = document.querySelectorAll<HTMLElement>('.bases-group-heading');
		const headerCount = allHeaders.length;

		// Quick exit if structure didn't change and all are patched
		if (headerCount === this._lastHeaderCount && headerCount > 0) {
			let allAlreadyPatched = true;
			for (let i = 0; i < headerCount; i++) {
				if (!this._patchedHeaders.has(allHeaders[i])) {
					allAlreadyPatched = false;
					break;
				}
			}
			if (allAlreadyPatched) {
				// Just sync UI state without full patch - and skip badges if not showing
				if (this.settings.showGroupCounts) {
					for (let i = 0; i < headerCount; i++) {
						this._updateBadgeQuick(allHeaders[i]);
					}
				}
				return;
			}
		}

		this._lastHeaderCount = headerCount;
		for (let i = 0; i < headerCount; i++) {
			this._patchHeader(allHeaders[i]);
		}
	}

	private _patchHeader(header: HTMLElement) {
		// Check if already patched (accounts for virtual scroll element reuse)
		const existingChevron = header.querySelector('.cgb-chevron');
		if (existingChevron) {
			// Already has chevron, just sync state
			this._patchedHeaders.add(header);
			this._syncHeaderUi(header);
			return;
		}

		// Only create chevron if not already present
		if (!this._patchedHeaders.has(header)) {
			header.setAttribute('data-cgb-patched', 'true');
			header.style.cursor = 'pointer';

			const chevron = document.createElement('span');
			chevron.className = 'cgb-chevron';
			chevron.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
			header.prepend(chevron);
			this._patchedHeaders.add(header);

			// Cache the header key for faster access
			this._headerKeyCache.set(header, this._headerKey(header));

			// In canvas nodes, stop pointerdown from bubbling to prevent canvas drag
			if (header.closest('.canvas-node')) {
				header.addEventListener('pointerdown', e => e.stopPropagation());
			}
		}
		this._syncHeaderUi(header);
	}

	private _collapseAllInCanvas(canvasNodeEl: HTMLElement) {
		const resolved = this._getResolvedSettings();
		const filePath = this._filePathForCanvasNode(canvasNodeEl) ?? '';
		const container = canvasNodeEl.querySelector('.bases-view.is-grouped');
		if (!container) return;
		const headers = container.querySelectorAll<HTMLElement>('.bases-group-heading');
		headers.forEach(h => {
			const groupValue = this._normalizeGroupValue(h.querySelector('.bases-group-value')?.textContent?.trim());
			const k = filePath ? `${filePath}::${groupValue}` : this._stateKey(groupValue);
			if (!this._collapsedKeys.has(k)) {
				this._collapsedKeys.add(k);
				if (resolved.rememberFoldState) this._foldState[k] = true;
			}
		});
		this._saveFoldState();
		this._applyCanvasNodeCollapse(canvasNodeEl);
	}

	private _expandAllInCanvas(canvasNodeEl: HTMLElement) {
		const resolved = this._getResolvedSettings();
		const filePath = this._filePathForCanvasNode(canvasNodeEl) ?? '';
		const container = canvasNodeEl.querySelector('.bases-view.is-grouped');
		if (!container) return;
		const headers = container.querySelectorAll<HTMLElement>('.bases-group-heading');
		headers.forEach(h => {
			const groupValue = this._normalizeGroupValue(h.querySelector('.bases-group-value')?.textContent?.trim());
			const k = filePath ? `${filePath}::${groupValue}` : this._stateKey(groupValue);
			if (this._collapsedKeys.has(k)) {
				this._collapsedKeys.delete(k);
				if (resolved.rememberFoldState) delete this._foldState[k];
			}
		});
		this._saveFoldState();
		this._applyCanvasNodeCollapse(canvasNodeEl);
	}

	private _collapseAllInEmbed(embedEl: HTMLElement) {
		const resolved = this._getResolvedSettings();
		const src = embedEl.getAttribute('src') ?? '';
		const container = embedEl.querySelector('.bases-view.is-grouped');
		if (!container) return;
		const headers = container.querySelectorAll<HTMLElement>('.bases-group-heading');
		headers.forEach(h => {
			const groupValue = this._normalizeGroupValue(h.querySelector('.bases-group-value')?.textContent?.trim());
			const k = `${src}::${groupValue}`;
			if (!this._collapsedKeys.has(k)) {
				this._collapsedKeys.add(k);
				if (resolved.rememberFoldState) this._foldState[k] = true;
			}
		});
		this._saveFoldState();
		this._applyEmbedCollapse(embedEl);
		this._applyCollapsedModelToEmbed(embedEl);
	}

	private _expandAllInEmbed(embedEl: HTMLElement) {
		const resolved = this._getResolvedSettings();
		const src = embedEl.getAttribute('src') ?? '';
		const container = embedEl.querySelector('.bases-view.is-grouped');
		if (!container) return;
		const headers = container.querySelectorAll<HTMLElement>('.bases-group-heading');
		headers.forEach(h => {
			const groupValue = this._normalizeGroupValue(h.querySelector('.bases-group-value')?.textContent?.trim());
			const k = `${src}::${groupValue}`;
			if (this._collapsedKeys.has(k)) {
				this._collapsedKeys.delete(k);
				if (resolved.rememberFoldState) delete this._foldState[k];
			}
		});
		this._saveFoldState();
		this._applyEmbedCollapse(embedEl);
		this._applyCollapsedModelToEmbed(embedEl);
	}

	private _toggle(header: HTMLElement) {
		const resolved = this._getResolvedSettings();
		if (!resolved.enableCollapsibleGroups) return;

		// Canvas node: skip toggle on first click (canvas focuses the node)
		const canvasNodeEl = header.closest('.canvas-node') as HTMLElement | null;
		if (canvasNodeEl && !canvasNodeEl.classList.contains('is-focused')) return;

		const key = this._headerKey(header);
		const wasCollapsed = this._collapsedKeys.has(key);
		if (wasCollapsed) this._collapsedKeys.delete(key);
		else this._collapsedKeys.add(key);

		this._persistKey(key);

		// For markdown-embedded views, apply collapse via data model + CSS
		const embedEl = header.closest('.internal-embed') as HTMLElement | null;
		if (embedEl) {
			this._applyEmbedCollapse(embedEl);
			this._syncHeaderUi(header);
			this._applyCollapsedModelToEmbed(embedEl);
			
			return;
		}

		// For canvas-embedded views, apply collapse via CSS on the canvas node container
		if (canvasNodeEl) {
			this._applyCanvasNodeCollapse(canvasNodeEl);
			this._syncHeaderUi(header);
			return;
		}

		this._refreshAfterStateChange(wasCollapsed ? key : undefined);
	}

	private _applyEmbedCollapse(embedEl: HTMLElement) {
		const resolved = this._getResolvedSettings();
		const container = embedEl.querySelector<HTMLElement>('.bases-view.is-grouped');
		if (!container) return;
		const src = embedEl.getAttribute('src') ?? '';
		const headers = container.querySelectorAll<HTMLElement>('.bases-group-heading');
		for (let i = 0; i < headers.length; i++) {
			const h = headers[i];
			const groupValue = this._normalizeGroupValue(h.querySelector('.bases-group-value')?.textContent?.trim());
			const k = `${src}::${groupValue}`;
			const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || this._collapsedKeys.has(k));
			const tableEl = h.closest('.bases-table') as HTMLElement | null;
			if (tableEl) {
				// Use data attribute so CSS !important rule survives virtual renderer re-renders
				if (collapsed) tableEl.setAttribute('data-cgb-collapsed', 'true');
				else tableEl.removeAttribute('data-cgb-collapsed');
			}
			this._syncHeaderUi(h);
		}
	}

	private _applyCanvasNodeCollapse(canvasNodeEl: HTMLElement) {
		const resolved = this._getResolvedSettings();
		const container = canvasNodeEl.querySelector('.bases-view.is-grouped');
		if (!container) return;
		const filePath = this._filePathForCanvasNode(canvasNodeEl) ?? '';
		const headers = container.querySelectorAll<HTMLElement>('.bases-group-heading');
		for (let i = 0; i < headers.length; i++) {
			const h = headers[i];
			const groupValue = this._normalizeGroupValue(h.querySelector('.bases-group-value')?.textContent?.trim());
			const k = filePath ? `${filePath}::${groupValue}` : this._stateKey(groupValue);
			const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || this._collapsedKeys.has(k));
			const tableEl = h.closest('.bases-table') as HTMLElement | null;
			if (tableEl) {
				if (collapsed) tableEl.setAttribute('data-cgb-collapsed', 'true');
				else tableEl.removeAttribute('data-cgb-collapsed');
			}
			this._syncHeaderUi(h);
		}
		this._applyCollapsedModelToCanvasNode(canvasNodeEl);
	}

	private _getCanvasTableView(canvasNodeEl: HTMLElement): BasesTableView | undefined {
		// Find the Bases table view by walking canvas nodes for the one whose nodeEl matches
		const leaves = this.app.workspace.getLeavesOfType('canvas');
		for (const leaf of leaves) {
			const canvas = (leaf.view as unknown as { canvas?: { nodes?: Map<string, { nodeEl?: HTMLElement; child?: { controller?: { _children?: unknown[] } } }> } })?.canvas;
			if (!canvas?.nodes) continue;
			let found: BasesTableView | undefined;
			canvas.nodes.forEach((node) => {
				if (found) return;
				if (node.nodeEl !== canvasNodeEl) return;
				const children = node.child?.controller?._children;
				if (!Array.isArray(children)) return;
				found = children.find((c: unknown) => {
					const m = c as BasesTableView;
					return typeof m?.display === 'function' && Array.isArray(m?.groups) && !!m?.scrollEl;
				}) as BasesTableView | undefined;
			});
			if (found) return found;
		}
		return undefined;
	}

	private _applyCollapsedModelToCanvasNode(canvasNodeEl: HTMLElement) {
		const resolved = this._getResolvedSettings();
		const filePath = this._filePathForCanvasNode(canvasNodeEl) ?? '';

		const table = this._getCanvasTableView(canvasNodeEl);
		if (!table?.data) return;

		if (!table.__cgbOriginalGroupedData) {
			const previousCache = table.data.groupedDataCache;
			table.data.groupedDataCache = null;
			table.__cgbOriginalGroupedData = (table.data.groupedData ?? []).map(group => ({
				...group, entries: group.entries.slice(),
			} as BasesGroup));
			table.data.groupedDataCache = previousCache ?? null;
		}

		table.data.groupedDataCache = table.__cgbOriginalGroupedData.map(group => {
			const clone = { ...group } as BasesGroup;
			const groupValue = this._normalizeGroupValue(this._groupValue(group));
			const key = filePath ? `${filePath}::${groupValue}` : this._stateKey(groupValue);
			const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || this._collapsedKeys.has(key));
			clone.entries = collapsed ? [] : group.entries.slice();
			return clone;
		});

		table.display?.();
		table.updateVirtualDisplay?.();
		this._fixGroupGaps(table);
		this._installGapFixer(table);

		// Re-patch headers after display() re-creates them
		requestAnimationFrame(() => {
			this._patchHeaders();
			this._patchToolbars();
		});
	}

	private _reflowCanvasNode(canvasNodeEl: HTMLElement) {
		const container = canvasNodeEl.querySelector<HTMLElement>('.bases-view.is-grouped');
		if (!container) return;
		const tableContainer = container.querySelector<HTMLElement>('.bases-table-container');
		if (!tableContainer) return;
		const tables = tableContainer.querySelectorAll<HTMLElement>(':scope > .bases-table');
		let top = 0;
		for (let i = 0; i < tables.length; i++) {
			const t = tables[i];
			const hdr = t.querySelector<HTMLElement>(':scope > .bases-group-heading');
			const tbody = t.querySelector<HTMLElement>(':scope > .bases-tbody');
			const headerH = hdr?.offsetHeight ?? 40;
			const bodyH = tbody && getComputedStyle(tbody).display !== 'none' ? (tbody.offsetHeight || 0) : 0;
			t.style.top = `${top}px`;
			top += headerH + bodyH;
		}
		tableContainer.style.height = `${top}px`;
	}

	private _applyCollapsedModelToEmbed(embedEl: HTMLElement) {
		// Like _applyCollapsedModelToActiveTable but for embedded bases views.
		// Modifies the embedded table's groupedDataCache so collapsed groups have 0 entries,
		// making Bases' virtual renderer position all groups compactly.
		const resolved = this._getResolvedSettings();
		const src = embedEl.getAttribute('src') ?? '';
		const widget = (embedEl as unknown as { cmView?: { widget?: { child?: { controller?: { _children?: unknown[] } } } } })?.cmView?.widget;
		const children = widget?.child?.controller?._children;
		if (!Array.isArray(children)) return;
		const table = children.find((c: unknown) => {
			const m = c as BasesTableView;
			return typeof m?.display === 'function' && Array.isArray(m?.groups) && !!m?.scrollEl;
		}) as BasesTableView | undefined;
		if (!table?.data) return;

		// Save original data if not already saved
		if (!table.__cgbOriginalGroupedData) {
			const previousCache = table.data.groupedDataCache;
			table.data.groupedDataCache = null;
			table.__cgbOriginalGroupedData = (table.data.groupedData ?? []).map(group => ({
				...group,
				entries: group.entries.slice(),
			} as BasesGroup));
			table.data.groupedDataCache = previousCache ?? null;
		}

		table.data.groupedDataCache = table.__cgbOriginalGroupedData.map(group => {
			const clone = { ...group } as BasesGroup;
			const groupValue = this._normalizeGroupValue(this._groupValue(group));
			const key = `${src}::${groupValue}`;
			const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || this._collapsedKeys.has(key));
			clone.entries = collapsed ? [] : group.entries.slice();
			return clone;
		});

		// Install a guard that re-applies the collapsed cache before every updateVirtualDisplay
		this._installEmbedUpdateGuard(embedEl, table);

		this._rerenderingEmbed = true;
		// Set the cache directly before display() so even the first render is correct
		table.data.groupedDataCache = table.__cgbOriginalGroupedData!.map(group => {
			const clone = { ...group } as BasesGroup;
			const groupValue = this._normalizeGroupValue(this._groupValue(group));
			const key = `${src}::${groupValue}`;
			const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || this._collapsedKeys.has(key));
			clone.entries = collapsed ? [] : group.entries.slice();
			return clone;
		});
		table.display?.();
		table.updateVirtualDisplay?.();

		// Patch headers after display() re-creates them, fix container height
		requestAnimationFrame(() => {
			this._patchEmbedHeaders(embedEl);
			this._patchToolbars();
			this._fixEmbedContainerHeight(embedEl, table);
			requestAnimationFrame(() => {
				this._rerenderingEmbed = false;
			});
		});
	}

	private _installEmbedUpdateGuard(embedEl: HTMLElement, table: BasesTableView) {
		// Guard: if Bases' internal observer resets groupedDataCache and calls
		// updateVirtualDisplay, our collapsed state gets lost. Wrap updateVirtualDisplay
		// to always re-apply the collapsed model before running.
		// Always reinstall — stale wrappers from previous builds need replacing
		(table as BasesTableView & { __cgbUpdateGuard?: boolean }).__cgbUpdateGuard = true;

		// Get the prototype's original function, bypassing any stale instance wrappers
		const origUpdate = Object.getPrototypeOf(table).updateVirtualDisplay!.bind(table);
		const self = this;
		table.updateVirtualDisplay = function(this: BasesTableView) {
			// ALWAYS re-apply collapsed cache before updateVirtualDisplay
			const src = embedEl.getAttribute('src') ?? '';
			const resolved = self._getResolvedSettings();
			if (this.data && this.__cgbOriginalGroupedData) {
				this.data.groupedDataCache = this.__cgbOriginalGroupedData.map(group => {
					const clone = { ...group } as BasesGroup;
					const groupValue = self._normalizeGroupValue(self._groupValue(group));
					const key = `${src}::${groupValue}`;
					const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || self._collapsedKeys.has(key));
					clone.entries = collapsed ? [] : group.entries.slice();
					return clone;
				});
			}
				return origUpdate();
		};
	}

	private _fixEmbedContainerHeight(embedEl: HTMLElement, table: BasesTableView) {
		// The .bases-table-container uses position:absolute children (virtual scroll).
		// After rendering, compute the total content height from each group's top + height,
		// and set the container height so the embed grows to fit all content.
		const container = table.containerEl as HTMLElement | undefined;
		if (!container) return;
		const tables = container.querySelectorAll<HTMLElement>(':scope > .bases-table');
		if (!tables.length) return;
		let maxBottom = 0;
		for (const t of Array.from(tables)) {
			const top = parseFloat(t.style.top) || 0;
			const header = t.querySelector<HTMLElement>(':scope > .bases-group-heading');
			const tbody = t.querySelector<HTMLElement>(':scope > .bases-tbody');
			const headerH = header?.offsetHeight ?? 40;
			const bodyH = tbody ? tbody.offsetHeight : 0;
			maxBottom = Math.max(maxBottom, top + headerH + bodyH);
		}
		if (maxBottom > 0) container.style.height = `${maxBottom}px`;
	}

	private _recalculateEmbedTablePositions(embedEl: HTMLElement) {
		// Recalculate top positions based on actual rendered heights, not virtual heights.
		// This eliminates gaps between groups in embeds.
		const container = embedEl.querySelector('.bases-table-container') as HTMLElement | null;
		if (!container) return;
		const tables = Array.from(container.querySelectorAll<HTMLElement>(':scope > .bases-table'));
		
		let currentTop = 0;
		for (const t of tables) {
			const header = t.querySelector<HTMLElement>(':scope > .bases-group-heading');
			const tbody = t.querySelector<HTMLElement>(':scope > .bases-tbody');
			const headerH = header?.offsetHeight ?? 40;
			const bodyH = tbody ? tbody.offsetHeight : 0;
			
			t.style.top = `${currentTop}px`;
			currentTop += headerH + bodyH;
		}
		
		// Update container height
		container.style.height = `${currentTop}px`;
	}

	private _watchEmbedVisibility(embedEl: HTMLElement) {
		// Already watching — skip
		if ((embedEl as HTMLElement & { __cgbVisibilityWatched?: boolean }).__cgbVisibilityWatched) return;
		(embedEl as HTMLElement & { __cgbVisibilityWatched?: boolean }).__cgbVisibilityWatched = true;

		// When the embed scrolls into view, trigger updateVirtualDisplay on the Bases table.
		// Bases' virtual renderer only renders rows visible in the window viewport.
		// If the embed starts below the viewport (common for long notes), rows won't render
		// until the embed is actually visible on screen.
		const getTable = () => {
			const widget = (embedEl as unknown as { cmView?: { widget?: { child?: { controller?: { _children?: unknown[] } } } } })?.cmView?.widget;
			const children = widget?.child?.controller?._children;
			if (!Array.isArray(children)) return undefined;
			return children.find((c: unknown) => {
				const m = c as BasesTableView;
				return typeof m?.display === 'function' && Array.isArray(m?.groups) && !!m?.scrollEl;
			}) as BasesTableView | undefined;
		};

		const io = new IntersectionObserver((entries) => {
			if (this._rerenderingEmbed) return;
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				// A group table scrolled into view — render its rows and sync chevrons
				const t = getTable();
				if (t) {
					t.updateVirtualDisplay?.();
					this._fixEmbedContainerHeight(embedEl, t);
				}
				this._patchEmbedHeaders(embedEl);
				break; // one call is enough per batch
			}
		}, { threshold: 0.01 });
		// Observe the embed container AND all individual group tables so rows render
		// when any group scrolls into view (including after expanding a group)
		io.observe(embedEl);
		embedEl.querySelectorAll<HTMLElement>('.bases-table').forEach(t => io.observe(t));

		// Re-observe when new tables are added (e.g. after display() call)
		const tableObserver = new MutationObserver(() => {
			embedEl.querySelectorAll<HTMLElement>('.bases-table').forEach(t => io.observe(t));
		});
		tableObserver.observe(embedEl, { childList: true, subtree: true });
		this._embedVisibilityObservers.push(io);
		// Store tableObserver as a fake IntersectionObserver (has disconnect)
		this._embedVisibilityObservers.push({ disconnect: () => tableObserver.disconnect() } as unknown as IntersectionObserver);
	}



	private _forceEmbedRerender(embedEl: HTMLElement, _virtualTop: number) {
		// Legacy stub — logic moved to _applyCollapsedModelToEmbed
		this._applyCollapsedModelToEmbed(embedEl);
	}



	private _reflowEmbed(_embedEl: HTMLElement) {
		// Virtual positioning is managed by Bases' renderer — we don't touch it.
		// Collapse state is controlled via data-cgb-collapsed attribute + CSS.
	}

	private _collapseAll() {
		const resolved = this._getResolvedSettings();
		const table = this._getActiveTableView();
		if (!table) return;

		// Clear the cached original data to force re-fetch from source
		delete table.__cgbOriginalGroupedData;
		delete table.__cgbGroupCountMap;

		// Use DOM to find ALL group headers, not just those in the virtual data
		// This ensures we collapse all groups even with virtual scrolling
		const headers = document.querySelectorAll<HTMLElement>('.bases-group-heading');
		let changed = false;

		for (let i = 0; i < headers.length; i++) {
			const header = headers[i];
			const key = this._headerKey(header);
			if (!this._collapsedKeys.has(key)) {
				this._collapsedKeys.add(key);
				if (resolved.rememberFoldState) this._foldState[key] = true;
				changed = true;
			}
		}

		if (changed) {
			this._saveFoldState();
			// Use batched RAF for UI update
			requestAnimationFrame(() => {
				this._applyCollapsedModelToActiveTable();
				this._patchHeaders();
				this._scrollActiveViewToTop();
			});
		}
	}

	private _expandAll() {
		const resolved = this._getResolvedSettings();
		const table = this._getActiveTableView();
		if (!table) return;

		// Clear the cached original data to force re-fetch from source
		delete table.__cgbOriginalGroupedData;
		delete table.__cgbGroupCountMap;

		// Use DOM to find ALL group headers, not just those in the virtual data
		// This ensures we expand all groups even with virtual scrolling
		const headers = document.querySelectorAll<HTMLElement>('.bases-group-heading');
		let changed = false;

		for (let i = 0; i < headers.length; i++) {
			const header = headers[i];
			const key = this._headerKey(header);
			if (this._collapsedKeys.has(key)) {
				this._collapsedKeys.delete(key);
				if (resolved.rememberFoldState) delete this._foldState[key];
				changed = true;
			}
		}

		if (changed) {
			this._saveFoldState();
			// Use batched RAF for UI update
			requestAnimationFrame(() => {
				this._applyCollapsedModelToActiveTable();
				this._patchHeaders();
				this._scrollActiveViewToTop();
			});
		}
	}

	private _refreshAfterStateChange(expandedKey?: string) {
		const table = this._getActiveTableView();
		const previousScrollTop = table?.scrollEl?.scrollTop ?? 0;
		this._applyCollapsedModelToActiveTable();
		this._patchHeaders();

		if (expandedKey) {
			const header = this._findHeaderByKey(expandedKey);
			if (header) {
				this._syncHeaderUi(header);
				this._scrollHeaderIntoView(header, previousScrollTop);
			}
		}
	}

	private _applyCollapsedModelToActiveTable() {
		const resolved = this._getResolvedSettings();
		const table = this._getActiveTableView();
		const data = table?.data;
		if (!table || !data) return;

		const original = this._getOriginalGroupedData(table);
		data.groupedDataCache = original.map(group => {
			const clone = { ...group } as BasesGroup;
			const key = this._stateKey(this._groupValue(group));
			const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || this._collapsedKeys.has(key));
			clone.entries = collapsed ? [] : group.entries.slice();
			return clone;
		});

		table.display?.();
		table.updateVirtualDisplay?.();
		this._fixGroupGaps(table);
		this._installGapFixer(table);
	}

	private _installGapFixer(table: BasesTableView) {
		// Patch updateVirtualDisplay on the table instance so _fixGroupGaps runs after every call.
		// This prevents Bases' scroll watcher from adding gaps back.
		if ((table as unknown as Record<string, unknown>).__cgbGapFixerInstalled) return;
		(table as unknown as Record<string, unknown>).__cgbGapFixerInstalled = true;
		const original = table.updateVirtualDisplay!.bind(table);
		const self = this;
		(table as unknown as Record<string, unknown>).updateVirtualDisplay = function(this: BasesTableView) {
			const result = original();
			self._fixGroupGaps(this);
			return result;
		};
	}

	private _fixGroupGaps(table: BasesTableView) {
		// After updateVirtualDisplay, Bases has positioned tables with --bases-table-group-gap
		// between each group. Recompute top values without the gap for compact collapsed layout.
		const container = table.containerEl;
		if (!container) return;
		const tables = container.querySelectorAll<HTMLElement>(':scope > .bases-table');
		let top = 0;
		for (let i = 0; i < tables.length; i++) {
			const t = tables[i];
			t.style.top = `${top}px`;
			// Height = header height (from BCR) + tbody height (from inline style, 0 for collapsed)
			const heading = t.querySelector<HTMLElement>(':scope > .bases-group-heading');
			const tbody = t.querySelector<HTMLElement>(':scope > .bases-tbody');
			const headingH = heading ? heading.getBoundingClientRect().height : 30;
			const tbodyH = tbody ? parseInt(tbody.style.height || '0', 10) : 0;
			top += headingH + tbodyH;
		}
		// Update container height to match
		if (container.parentElement) {
			container.style.height = `${top}px`;
		}
	}

	private _resetGroupedDataCache() {
		const table = this._getActiveTableView();
		if (!table?.data) return;
		table.data.groupedDataCache = null;
		delete table.__cgbOriginalGroupedData;
		delete table.__cgbGroupCountMap;
	}

	private _getOriginalGroupedData(table: BasesTableView): BasesGroup[] {
		if (!table.data) return [];

		const previousCache = table.data.groupedDataCache;
		table.data.groupedDataCache = null;
		const source = (table.data.groupedData ?? []).map(group => ({
			...group,
			entries: group.entries.slice(),
		} as BasesGroup));
		table.data.groupedDataCache = previousCache ?? null;

		const needsRefresh =
			!table.__cgbOriginalGroupedData ||
			table.__cgbOriginalGroupedData.length !== source.length ||
			table.__cgbOriginalGroupedData.some((group, index) => {
				const next = source[index];
				return this._groupValue(group) !== this._groupValue(next) || group.entries.length !== next.entries.length;
			});

		if (needsRefresh) {
			table.__cgbOriginalGroupedData = source;
			table.__cgbGroupCountMap = Object.fromEntries(source.map(group => [this._groupValue(group), group.entries.length]));
		}

		return table.__cgbOriginalGroupedData ?? source;
	}

	private _displayActiveTable() {
		const table = this._getActiveTableView();
		table?.display?.();
		table?.updateVirtualDisplay?.();
	}

	private _scrollActiveViewToTop() {
		const table = this._getActiveTableView();
		if (!table?.scrollEl) return;
		table.scrollEl.scrollTop = 0;
		requestAnimationFrame(() => {
			table.updateVirtualDisplay?.();
			this._patchHeaders();
		});
	}

	private _syncHeaderUi(header: HTMLElement) {
		const resolved = this._getResolvedSettings();
		const chevron = header.querySelector<HTMLElement>('.cgb-chevron');
		if (!chevron) return;
		const key = this._headerKey(header);
		const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || this._collapsedKeys.has(key));

		// Update chevron state
		const wasCollapsed = chevron.classList.contains('is-collapsed');
		if (collapsed !== wasCollapsed) {
			chevron.classList.toggle('is-collapsed', collapsed);
		}
		chevron.style.opacity = resolved.enableCollapsibleGroups ? '0.7' : '0.35';

		// Update badge if showing counts
		if (resolved.showGroupCounts) this._showBadge(header);
		else header.querySelector('.cgb-count-badge')?.remove();
	}

	private _syncHeaderUiLightweight(header: HTMLElement) {
		// Lightweight update for counts only, without chevron state changes
		const resolved = this._getResolvedSettings();
		if (resolved.showGroupCounts) this._showBadge(header);
		else header.querySelector('.cgb-count-badge')?.remove();
	}

	private _updateAllBadgesQuick() {
		// Fast path: update only badges without full header patching
		const resolved = this._getResolvedSettings();
		const headers = document.querySelectorAll<HTMLElement>('.bases-group-heading[data-cgb-patched]');
		for (let i = 0; i < headers.length; i++) {
			if (resolved.showGroupCounts) {
				this._showBadge(headers[i]);
			} else {
				headers[i].querySelector('.cgb-count-badge')?.remove();
			}
		}
	}

	private _scrollHeaderIntoView(header: HTMLElement, fallbackTop: number) {
		const view = header.closest<HTMLElement>('.bases-view.is-grouped');
		const table = header.closest<HTMLElement>('.bases-table');
		if (!view || !table) return;
		const target = Math.max(0, parseFloat(table.style.top || '0') - 30);
		view.scrollTop = Number.isFinite(target) ? target : fallbackTop;
	}

	private _findHeaderByKey(key: string): HTMLElement | null {
		return (
			Array.from(document.querySelectorAll<HTMLElement>('.bases-group-heading')).find(
				header => this._headerKey(header) === key,
			) ?? null
		);
	}

	private _getActiveTableView(): BasesTableView | null {
		const leafView = this.app.workspace.activeLeaf?.view as { controller?: { _children?: unknown[] } } | undefined;
		const children = leafView?.controller?._children;
		if (!Array.isArray(children)) return null;
		const table = children.find(child => {
			const maybe = child as BasesTableView;
			return typeof maybe?.display === 'function' && Array.isArray(maybe?.groups) && !!maybe?.scrollEl;
		}) as BasesTableView | undefined;
		return table ?? null;
	}

	private _normalizeGroupValue(value: string | null | undefined): string {
		const normalized = (value ?? '').trim();
		if (!normalized) return 'None';
		const lowered = normalized.toLowerCase();
		if (lowered === 'none' || lowered === 'null' || lowered === 'undefined') return 'None';
		return normalized;
	}

	private _groupValue(group: BasesGroup): string {
		return this._normalizeGroupValue(group.key?.toString?.());
	}

	private _headerKey(header: HTMLElement): string {
		const groupValue = this._normalizeGroupValue(header.querySelector('.bases-group-value')?.textContent?.trim());
		// For markdown-embedded bases, resolve the actual .base file path from src attribute
		const embedEl = header.closest('.internal-embed') as HTMLElement | null;
		if (embedEl) {
			const src = embedEl.getAttribute('src');
			if (src) return `${src}::${groupValue}`;
		}
		// For canvas-embedded bases, resolve the file path from the canvas node data
		const canvasNodeEl = header.closest('.canvas-node') as HTMLElement | null;
		if (canvasNodeEl) {
			const filePath = this._filePathForCanvasNode(canvasNodeEl);
			if (filePath) return `${filePath}::${groupValue}`;
		}
		return this._stateKey(groupValue);
	}

	private _getCanvasNodeTableView(canvasNodeEl: HTMLElement): BasesTableView | null {
		const canvasLeaf = this.app.workspace.getLeavesOfType('canvas')[0];
		const canvasNodes = (canvasLeaf?.view as unknown as { canvas?: { nodes?: Map<string, { nodeEl?: HTMLElement; child?: { controller?: { _children?: unknown[] } } }> } })?.canvas?.nodes;
		if (!canvasNodes) return null;
		for (const node of canvasNodes.values()) {
			if (node.nodeEl === canvasNodeEl) {
				const children = node.child?.controller?._children;
				if (!Array.isArray(children)) return null;
				return children.find((c: unknown) => {
					const m = c as BasesTableView;
					return typeof m?.display === 'function' && Array.isArray(m?.groups) && !!m?.scrollEl;
				}) as BasesTableView ?? null;
			}
		}
		return null;
	}

	private _filePathForCanvasNode(canvasNodeEl: HTMLElement): string | null {
		const canvasLeaf = this.app.workspace.getLeavesOfType('canvas')[0];
		const canvasNodes = (canvasLeaf?.view as unknown as { canvas?: { nodes?: Map<string, { nodeEl?: HTMLElement; getData?: () => { file?: string } }> } })?.canvas?.nodes;
		if (!canvasNodes) return null;
		for (const node of canvasNodes.values()) {
			if (node.nodeEl === canvasNodeEl) {
				return node.getData?.()?.file ?? null;
			}
		}
		return null;
	}

	private _stateKey(groupValue: string): string {
		const filePath = this.app.workspace.getActiveFile()?.path ?? 'unknown';
		return `${filePath}::${groupValue}`;
	}

	private _persistKey(key: string) {
		const resolved = this._getResolvedSettings();
		if (!resolved.rememberFoldState) return;
		if (this._collapsedKeys.has(key)) this._foldState[key] = true;
		else delete this._foldState[key];
		this._saveFoldState();
	}

	private _showBadge(header: HTMLElement) {
		let badge = header.querySelector<HTMLElement>('.cgb-count-badge');
		if (!badge) {
			badge = document.createElement('span');
			badge.className = 'cgb-count-badge';
			header.appendChild(badge);
		}
		const groupValue = header.querySelector('.bases-group-value')?.textContent?.trim() ?? '';
		const count = this._getGroupCountForHeader(header, groupValue);
		if (badge.textContent !== `(${count})`) {
			badge.textContent = `(${count})`;
		}
	}

	private _updateBadgeQuick(header: HTMLElement) {
		const badge = header.querySelector<HTMLElement>('.cgb-count-badge');
		if (!badge) return;
		const groupValue = header.querySelector('.bases-group-value')?.textContent?.trim() ?? '';
		const count = this._getGroupCountForHeader(header, groupValue);
		if (badge.textContent !== `(${count})`) {
			badge.textContent = `(${count})`;
		}
	}

	private _getGroupCountForHeader(header: HTMLElement, groupValue: string): number {
		// For markdown-embedded views, look up count from the embedded controller
		const embedEl = header.closest('.internal-embed') as HTMLElement | null;
		if (embedEl) {
			const widget = (embedEl as unknown as { cmView?: { widget?: { child?: { controller?: { _children?: unknown[] } } } } })?.cmView?.widget;
			const controller = widget?.child?.controller;
			const children = Array.isArray(controller?._children) ? controller._children as BasesTableView[] : [];
			const embedTable = children.find(c => typeof c?.display === 'function' && Array.isArray(c?.groups) && !!c?.scrollEl) as BasesTableView | undefined;
			if (embedTable) {
				if (!embedTable.__cgbGroupCountMap) this._getOriginalGroupedData(embedTable);
				const norm = this._normalizeGroupValue(groupValue);
				if (embedTable.__cgbGroupCountMap?.[norm] !== undefined) return embedTable.__cgbGroupCountMap[norm];
			}
			return 0;
		}

		// For canvas node embeds, find the table view via canvas node's child controller
		const canvasNodeEl = header.closest('.canvas-node') as HTMLElement | null;
		if (canvasNodeEl) {
			const table = this._getCanvasNodeTableView(canvasNodeEl);
			if (table) {
				if (!table.__cgbGroupCountMap) this._getOriginalGroupedData(table);
				const norm = this._normalizeGroupValue(groupValue);
				if (table.__cgbGroupCountMap?.[norm] !== undefined) return table.__cgbGroupCountMap[norm];
			}
		}

		return this._getGroupCount(groupValue);
	}

	private _getGroupCount(groupValue: string): number {
		const table = this._getActiveTableView();
		if (!table) return 0;

		if (table.__cgbGroupCountMap?.[groupValue] !== undefined) {
			return table.__cgbGroupCountMap[groupValue];
		}

		this._getOriginalGroupedData(table);
		return table.__cgbGroupCountMap?.[groupValue] ?? 0;
	}

	async loadSettings() {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
	}

	async saveSettings() {
		const data = (await this.loadData()) ?? {};
		data.settings = this.settings;
		await this.saveData(data);
		// Mark cache as dirty since global settings changed
		this._baseConfigCacheDirty = true;
	}

	private async _loadFoldState() {
		const data = await this.loadData();
		this._foldState = data?.foldState ?? {};
	}

	private async _saveFoldState() {
		const data = (await this.loadData()) ?? {};
		data.foldState = this._foldState;
		await this.saveData(data);
	}
}

class CgbSettingTab extends PluginSettingTab {
	plugin: CollapsibleGroupsPlugin;

	constructor(app: App, plugin: CollapsibleGroupsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();


		new Setting(containerEl)
			.setName('Show feature toolbar')
			.setDesc('Show feature buttons above grouped Bases views.')
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.showToolbarButtons).onChange(async value => {
					this.plugin.settings.showToolbarButtons = value;
					await this.plugin.saveSettings();
					(this.plugin as unknown as { _refreshAllGroupedViews: () => void })._refreshAllGroupedViews();
				}),
			);

		new Setting(containerEl)
			.setName('Toolbar button display')
			.setDesc('Choose whether toolbar buttons show icons, text, or both.')
			.addDropdown(dropdown =>
				dropdown
					.addOption('icon', 'Icon only')
					.addOption('text', 'Text only')
					.addOption('both', 'Icon and text')
					.setValue(this.plugin.settings.toolbarButtonDisplay)
					.onChange(async value => {
						this.plugin.settings.toolbarButtonDisplay = value as 'icon' | 'text' | 'both';
						await this.plugin.saveSettings();
						(this.plugin as unknown as { _refreshAllGroupedViews: () => void })._refreshAllGroupedViews();
					}),
			);

		containerEl.createEl('h3', { text: 'Collapsing Groups' });

		new Setting(containerEl)
			.setName('Apply collapsible groups by default')
			.setDesc('Makes grouped Bases views collapsible unless a specific view overrides that default.')
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.enableCollapsibleGroups).onChange(async value => {
					this.plugin.settings.enableCollapsibleGroups = value;
					await this.plugin.saveSettings();
					(this.plugin as unknown as { _refreshAllGroupedViews: () => void })._refreshAllGroupedViews();
				}),
			);

		new Setting(containerEl)
			.setName('Remember collapse state')
			.setDesc('Keep each group\'s collapsed or expanded state between sessions.')
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.rememberFoldState).onChange(async value => {
					this.plugin.settings.rememberFoldState = value;
					await this.plugin.saveSettings();
				}),
			);

		containerEl.createEl('h3', { text: 'Count by Group' });

		new Setting(containerEl)
			.setName('Show counts by default')
			.setDesc('Shows record counts beside group names unless a specific view overrides that default.')
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.showGroupCounts).onChange(async value => {
					this.plugin.settings.showGroupCounts = value;
					await this.plugin.saveSettings();
					(this.plugin as unknown as { _refreshAllGroupedViews: () => void })._refreshAllGroupedViews();
				}),
			);

	}
}
