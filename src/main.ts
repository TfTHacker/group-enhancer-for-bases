import { App, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import { BaseConfigManager, BaseGroupEnhancerConfig } from './base-config';
import { ConfigResolver, ResolvedConfig } from './config-resolver';
import { clearDragDomState, syncDragDecorations } from './drag-dom';
import { applyMobileResolvedOverrides, isFeatureEnabledOnCurrentDevice } from './feature-gates';
import { getWritableGroupField, WritableGroupField } from './group-field';

interface CgbSettings {
	enableCollapsibleGroups: boolean;
	enableCollapsibleGroupsMobile: boolean;
	rememberFoldState: boolean;
	collapseAllByDefault: boolean;
	showToolbarButtons: boolean;
	showToolbarButtonsMobile: boolean;
	toolbarButtonDisplay: 'icon' | 'text' | 'both';
	showGroupCounts: boolean;
	showGroupCountsMobile: boolean;
	enableDragAndDrop: boolean;
	enableDragAndDropMobile: boolean;
}

const DEFAULT_SETTINGS: CgbSettings = {
	enableCollapsibleGroups: true,
	enableCollapsibleGroupsMobile: true,
	rememberFoldState: true,
	collapseAllByDefault: false,
	showToolbarButtons: true,
	showToolbarButtonsMobile: true,
	toolbarButtonDisplay: 'both',
	showGroupCounts: true,
	showGroupCountsMobile: true,
	enableDragAndDrop: true,
	enableDragAndDropMobile: true,
};

type BasesGroup = {
	key?: { toString?: () => string; renderTo?: (el: HTMLElement, ctx: unknown) => void; data?: string };
	entries: unknown[];
	tableEl?: HTMLElement;
	tbodyEl?: HTMLElement;
	summaryRow?: { shouldDisplay?: () => boolean; el?: HTMLElement };
};

type BasesRowEntry = {
	file?: TFile;
	frontmatter?: Record<string, unknown>;
};

type BasesRowCell = {
	view?: unknown;
	prop?: unknown;
	el?: HTMLElement;
	renderer?: unknown;
};

type BasesRow = {
	cells?: BasesRowCell[];
	view?: unknown;
	el?: HTMLElement;
	entry?: BasesRowEntry;
};

type BasesQueryController = {
	update?: () => void;
};

type BasesData = {
	groupedDataCache?: BasesGroup[] | null;
	groupedData?: BasesGroup[];
	properties?: string[];
	data?: unknown[];
};

type BasesTableView = {
	config?: { get?: (key: string) => unknown; groupBy?: { property?: string } };
	data?: BasesData;
	groups?: BasesGroup[];
	rows?: BasesRow[];
	scrollEl?: HTMLElement;
	containerEl?: HTMLElement;
	display?: () => void;
	updateVirtualDisplay?: () => void;
	onDataUpdated?: () => void;
	queryController?: BasesQueryController;
	lastViewport?: { left: number; right: number; top: number; bottom: number };
	createGroupHeadingEl?: (group: BasesGroup) => HTMLElement | null;
	__cgbOriginalGroupedData?: BasesGroup[];
	__cgbGroupCountMap?: Record<string, number>;
	__cgbGapFixerInstalled?: boolean;
	__cgbOriginalUpdateVirtualDisplay?: (() => void) | null;
	__cgbWrappedMode?: string | null;
};

type RuntimeKind = 'direct' | 'embed' | 'canvas';

type RuntimeContext = {
	kind: RuntimeKind;
	hostEl: HTMLElement;
	viewEl: HTMLElement;
	table: BasesTableView;
	sourceKey: string;
	getHeaders: () => HTMLElement[];
	afterRender: () => void;
};

type DragState = {
	runtimeKind: RuntimeKind;
	runtimeSourceKey: string;
	file: TFile;
	rowEl: HTMLElement;
	handleEl: HTMLElement;
	sourceGroupValue: string;
	dragPreviewEl?: HTMLElement | null;
};

type TouchDragState = {
	pointerId: number;
	runtime: RuntimeContext;
	file: TFile;
	rowEl: HTMLElement;
	handleEl: HTMLElement;
	sourceGroupValue: string;
	startX: number;
	startY: number;
	lastX: number;
	lastY: number;
	activated: boolean;
	holdTimer: number | null;
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
	private _dataRefreshTimer: number | null = null;
	private _rerenderingEmbed: boolean = false;
	private _styleEl: HTMLStyleElement | null = null;
	private _boundPointerUp?: (e: PointerEvent) => void;
	private _boundPointerMove?: (e: PointerEvent) => void;
	private _boundPointerCancel?: (e: PointerEvent) => void;
	private _patchedHeaders: Set<HTMLElement> = new Set();
	private _lastHeaderCount: number = 0;
	private _headerKeyCache: Map<HTMLElement, string> = new Map();
	private _reloadingDirectLeaf = false;
	private _directRefreshInFlight = false;
	private _lastDirectRefreshAt = 0;
	private _boundDragOver?: (e: DragEvent) => void;
	private _boundDrop?: (e: DragEvent) => void;
	private _boundDragEnd?: (_e: DragEvent) => void;
	private _dragState: DragState | null = null;
	private _touchDragState: TouchDragState | null = null;
	private _hoveredDropTable: HTMLElement | null = null;
	private _dragMoveInFlight = false;
	private _suppressHeaderToggleUntil = 0;

	// Base config management
	private _baseConfigManager: BaseConfigManager | null = null;
	private _currentBaseConfig: BaseGroupEnhancerConfig | null = null;
	private _currentBaseFile: string | null = null;
	private _currentViewName: string | null = null;
	private _cachedResolvedSettings: ResolvedConfig | null = null;
	private _baseConfigCacheDirty: boolean = true;

	private _syncCollapsedKeysFromFoldState() {
		this._collapsedKeys = new Set(Object.keys(this._foldState));
	}

	private _isMobileUi(): boolean {
		return !!(this.app as App & { isMobile?: boolean }).isMobile;
	}

	private _isFeatureEnabledOnCurrentDevice(enabled: boolean, mobileEnabled: boolean): boolean {
		return isFeatureEnabledOnCurrentDevice(enabled, mobileEnabled, this._isMobileUi());
	}

	private _isGloballyEnabled(): boolean {
		return this._isFeatureEnabledOnCurrentDevice(
			this.settings.enableCollapsibleGroups,
			this.settings.enableCollapsibleGroupsMobile,
		);
	}

	private _isRuntimeEnabled(): boolean {
		return this._isGloballyEnabled() && this._getResolvedSettings().enableCollapsibleGroups;
	}

	private _isDragAndDropConfiguredEnabled(): boolean {
		return this._isFeatureEnabledOnCurrentDevice(
			this.settings.enableDragAndDrop,
			this.settings.enableDragAndDropMobile,
		);
	}

	private _isDragAndDropEnabled(): boolean {
		return this._isDragAndDropConfiguredEnabled();
	}

	private _hasActiveRuntimeEnhancements(): boolean {
		return this._isRuntimeEnabled() || this._isDragAndDropConfiguredEnabled();
	}

	private _isActiveGroupedBasesView(): boolean {
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf || leaf.view?.getViewType?.() !== 'bases') return false;
		return !!leaf.view.containerEl?.querySelector('.bases-view.is-grouped');
	}

	private _resetPatchedHeaderState() {
		this._patchedHeaders.clear();
		this._headerKeyCache.clear();
		this._lastHeaderCount = 0;
	}

	private _removeRuntimeDomState(root: ParentNode = document) {
		root.querySelectorAll('.cgb-toolbar, .cgb-chevron, .cgb-count-badge, .cgb-row-drag-handle').forEach(el => el.remove());
		root.querySelectorAll<HTMLElement>('[data-cgb-patched],[data-cgb-container-patched],[data-cgb-initializing],[data-cgb-collapsed],[data-cgb-drop-target],[data-cgb-row-draggable],[data-cgb-row-drag-cell]').forEach(el => {
			el.removeAttribute('data-cgb-patched');
			el.removeAttribute('data-cgb-container-patched');
			el.removeAttribute('data-cgb-initializing');
			el.removeAttribute('data-cgb-collapsed');
			el.removeAttribute('data-cgb-drop-target');
			el.removeAttribute('data-cgb-row-draggable');
			el.removeAttribute('data-cgb-row-drag-cell');
			if (el.classList.contains('bases-group-heading')) el.style.cursor = '';
		});
		root.querySelectorAll<HTMLElement>('.is-cgb-drop-target, .is-cgb-drop-active, .is-cgb-row-dragging').forEach(el => {
			el.classList.remove('is-cgb-drop-target', 'is-cgb-drop-active', 'is-cgb-row-dragging');
		});
		root.querySelectorAll<HTMLElement>('.bases-tbody').forEach(el => {
			el.style.height = '';
		});
		root.querySelectorAll<HTMLElement>('.internal-embed.bases-embed').forEach(el => {
			delete (el as HTMLElement & { __cgbModelApplied?: boolean }).__cgbModelApplied;
			delete (el as HTMLElement & { __cgbVisibilityWatched?: boolean }).__cgbVisibilityWatched;
		});
	}

	private _removeDragDomState(root: ParentNode = document) {
		clearDragDomState(root);
	}

	private _getManagedLeaves(): WorkspaceLeaf[] {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves(leaf => {
			const type = leaf.view?.getViewType?.();
			if (type === 'bases' || type === 'markdown' || type === 'canvas') leaves.push(leaf);
		});
		return leaves;
	}

	private _getGroupedViewInLeaf(leaf: WorkspaceLeaf | null | undefined): HTMLElement | null {
		return (leaf?.view?.containerEl?.querySelector('.bases-view.is-grouped') as HTMLElement | null) ?? null;
	}

	private _isRenderableEmbedEl(embedEl: HTMLElement | null | undefined): embedEl is HTMLElement {
		if (!embedEl?.isConnected) return false;
		if (embedEl.classList.contains('is-loaded') === false) return false;
		if (embedEl.offsetParent !== null) return true;
		return embedEl.getClientRects().length > 0;
	}

	private _isGroupedTableView(table: BasesTableView | null | undefined, leaf?: WorkspaceLeaf | null): boolean {
		if (!table) return false;
		const groupBy = table.config?.groupBy?.property;
		if (typeof groupBy === 'string' && groupBy.length > 0) return true;
		if (leaf && this._getGroupedViewInLeaf(leaf)) return true;
		return false;
	}

	private _buildCollapsedGroups(table: BasesTableView, sourceKey: string, resolved: ResolvedConfig): BasesGroup[] {
		return this._getOriginalGroupedData(table).map(group => {
			const clone = { ...group } as BasesGroup;
			const key = `${sourceKey}::${this._groupValue(group)}`;
			const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || this._collapsedKeys.has(key));
			clone.entries = collapsed ? [] : group.entries.slice();
			return clone;
		});
	}

	private _cleanupTableRuntime(table: BasesTableView | null | undefined) {
		if (!table) return;
		const nativeUpdateVirtualDisplay = this._getNativeUpdateVirtualDisplay(table);
		if (nativeUpdateVirtualDisplay) table.updateVirtualDisplay = nativeUpdateVirtualDisplay;
		table.__cgbOriginalUpdateVirtualDisplay = null;
		table.__cgbWrappedMode = null;
		if (table.data) {
			table.data.groupedDataCache = null;
		}
		delete table.__cgbOriginalGroupedData;
		delete table.__cgbGroupCountMap;
		delete table.__cgbGapFixerInstalled;
	}

	private _getNativeUpdateVirtualDisplay(table: BasesTableView): (() => void) | null {
		const protoUpdate = Object.getPrototypeOf(table)?.updateVirtualDisplay;
		if (typeof protoUpdate === 'function') return protoUpdate.bind(table) as () => void;
		return table.__cgbOriginalUpdateVirtualDisplay ?? table.updateVirtualDisplay?.bind(table) ?? null;
	}

	private _cleanupRuntimeContext(runtime: RuntimeContext) {
		this._cleanupTableRuntime(runtime.table);
		runtime.viewEl.querySelectorAll<HTMLElement>('[data-cgb-collapsed]').forEach(el => el.removeAttribute('data-cgb-collapsed'));
		runtime.viewEl.querySelectorAll<HTMLElement>('.bases-tbody').forEach(el => {
			el.style.height = '';
		});
		runtime.hostEl.parentElement?.querySelector('.cgb-toolbar')?.remove();
		runtime.viewEl.querySelectorAll('.cgb-chevron, .cgb-count-badge, .cgb-row-drag-handle').forEach(el => el.remove());
		runtime.viewEl.querySelectorAll<HTMLElement>('[data-cgb-patched],[data-cgb-container-patched],[data-cgb-initializing],[data-cgb-drop-target],[data-cgb-row-draggable],[data-cgb-row-drag-cell]').forEach(el => {
			el.removeAttribute('data-cgb-patched');
			el.removeAttribute('data-cgb-container-patched');
			el.removeAttribute('data-cgb-initializing');
			el.removeAttribute('data-cgb-drop-target');
			el.removeAttribute('data-cgb-row-draggable');
			el.removeAttribute('data-cgb-row-drag-cell');
			if (el.classList.contains('bases-group-heading')) el.style.cursor = '';
		});
		runtime.viewEl.querySelectorAll<HTMLElement>('.is-cgb-drop-target, .is-cgb-drop-active, .is-cgb-row-dragging').forEach(el => {
			el.classList.remove('is-cgb-drop-target', 'is-cgb-drop-active', 'is-cgb-row-dragging');
		});
		runtime.table.display?.();
		runtime.table.updateVirtualDisplay?.();
	}

	private _getDirectRuntime(): RuntimeContext | null {
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf || leaf.view?.getViewType?.() !== 'bases') return null;
		const viewEl = this._getGroupedViewInLeaf(leaf);
		const table = this._getActiveTableView();
		const filePath = (leaf.view as { file?: TFile }).file?.path ?? this.app.workspace.getActiveFile()?.path ?? null;
		if (!viewEl || !filePath || !this._isGroupedTableView(table, leaf)) return null;
		return {
			kind: 'direct',
			hostEl: viewEl,
			viewEl,
			table: table as BasesTableView,
			sourceKey: filePath,
			getHeaders: () => Array.from(viewEl.querySelectorAll<HTMLElement>('.bases-group-heading')),
			afterRender: () => {
				this._fixGroupGaps(table as BasesTableView);
			},
		};
	}

	private _getEmbedRuntime(embedEl: HTMLElement): RuntimeContext | null {
		const viewEl = embedEl.querySelector<HTMLElement>('.bases-view.is-grouped');
		if (!viewEl) return null;
		const widget = (embedEl as unknown as { cmView?: { widget?: { child?: { controller?: { _children?: unknown[] } } } } })?.cmView?.widget;
		const children = widget?.child?.controller?._children;
		if (!Array.isArray(children)) return null;
		const table = children.find((c: unknown) => {
			const m = c as BasesTableView;
			return typeof m?.display === 'function' && Array.isArray(m?.groups) && !!m?.scrollEl;
		}) as BasesTableView | undefined;
		const sourceKey = embedEl.getAttribute('src');
		if (!table || !sourceKey || !this._isGroupedTableView(table)) return null;
		return {
			kind: 'embed',
			hostEl: embedEl,
			viewEl,
			table,
			sourceKey,
			getHeaders: () => Array.from(viewEl.querySelectorAll<HTMLElement>('.bases-group-heading')),
			afterRender: () => {
				this._fixEmbedContainerHeight(embedEl, table);
				this._repackEmbedTables(embedEl);
			},
		};
	}

	private _getCanvasRuntime(canvasNodeEl: HTMLElement): RuntimeContext | null {
		const viewEl = canvasNodeEl.querySelector<HTMLElement>('.bases-view.is-grouped');
		if (!viewEl) return null;
		const table = this._getCanvasTableView(canvasNodeEl);
		const sourceKey = this._filePathForCanvasNode(canvasNodeEl);
		if (!table || !sourceKey || !this._isGroupedTableView(table)) return null;
		return {
			kind: 'canvas',
			hostEl: canvasNodeEl,
			viewEl,
			table,
			sourceKey,
			getHeaders: () => Array.from(viewEl.querySelectorAll<HTMLElement>('.bases-group-heading')),
			afterRender: () => {
				this._reflowCanvasNode(canvasNodeEl);
			},
		};
	}

	private _getActiveRuntimes(): RuntimeContext[] {
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf) return [];
		const type = leaf.view?.getViewType?.();
		if (type === 'bases') {
			const runtime = this._getDirectRuntime();
			return runtime ? [runtime] : [];
		}
		if (type === 'markdown') {
			return Array.from(leaf.view.containerEl?.querySelectorAll<HTMLElement>('.internal-embed.bases-embed') ?? [])
				.filter(embedEl => this._isRenderableEmbedEl(embedEl))
				.map(embedEl => this._getEmbedRuntime(embedEl))
				.filter((runtime): runtime is RuntimeContext => !!runtime);
		}
		if (type === 'canvas') {
			return Array.from(leaf.view.containerEl?.querySelectorAll<HTMLElement>('.canvas-node') ?? [])
				.map(nodeEl => this._getCanvasRuntime(nodeEl))
				.filter((runtime): runtime is RuntimeContext => !!runtime);
		}
		return [];
	}

	private _refreshActiveRuntimes() {
		if (!this._hasActiveRuntimeEnhancements()) {
			this._removeRuntimeDomState();
			return;
		}
		const runtimes = this._getActiveRuntimes();
		if (!runtimes.length) {
			this._removeRuntimeDomState();
			return;
		}
		const hasDirectRuntime = runtimes.some(runtime => runtime.kind === 'direct');
		if (hasDirectRuntime) this._directRefreshInFlight = true;
		this._setInitializingState(true);
		requestAnimationFrame(() => {
			this._cleanupOrphanedElements();
			for (const runtime of runtimes) {
				this._applyCollapsedModel(runtime);
			}
			this._patchToolbars(runtimes);
			this._patchHeaders();
			requestAnimationFrame(() => {
				if (hasDirectRuntime) {
					this._directRefreshInFlight = false;
					this._lastDirectRefreshAt = Date.now();
				}
				this._setInitializingState(false);
			});
		});
	}

	private _shouldSkipDirectRefresh(): boolean {
		return this._directRefreshInFlight || (Date.now() - this._lastDirectRefreshAt) < 250;
	}

	private _cleanupActiveRuntimes() {
		for (const runtime of this._getActiveRuntimes()) {
			this._cleanupRuntimeContext(runtime);
		}
		this._removeRuntimeDomState();
		this._resetPatchedHeaderState();
	}

	private async _reloadActiveBasesLeaf(file: TFile | null) {
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf || leaf.view?.getViewType?.() !== 'bases' || !file || this._reloadingDirectLeaf) return;
		this._reloadingDirectLeaf = true;
		try {
			await (leaf as WorkspaceLeaf & { openFile?: (file: TFile) => Promise<void> | void }).openFile?.(file);
		} finally {
			window.setTimeout(() => {
				this._reloadingDirectLeaf = false;
			}, 150);
		}
	}

	private async _rebuildManagedLeaves() {
		for (const leaf of this._getManagedLeaves()) {
			try {
				await (leaf as WorkspaceLeaf & { rebuildView?: () => Promise<void> | void }).rebuildView?.();
			} catch (error) {
				console.error('[CGBDisable] Failed to rebuild leaf:', error);
			}
		}
	}

	private async _disableRuntime() {
		if (this._patchTimer) clearTimeout(this._patchTimer);
		if (this._refreshTimer) clearTimeout(this._refreshTimer);
		this._rerenderingEmbed = false;
		this._cleanupActiveRuntimes();
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile?.path.endsWith('.base')) {
			await this._reloadActiveBasesLeaf(activeFile);
		}
	}

	async onload() {
		await this.loadSettings();
		await this._loadFoldState();
		this._syncCollapsedKeysFromFoldState();

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
				const ok = resolved.enableCollapsibleGroups && this._isActiveGroupedBasesView() && !!this._getActiveTableView();
				if (!checking && ok) this._collapseAll();
				return ok;
			},
		});
		this.addCommand({
			id: 'expand-all-groups',
			name: 'Expand all groups in current Bases view',
			checkCallback: (checking: boolean) => {
				const resolved = this._getResolvedSettings();
				const ok = resolved.enableCollapsibleGroups && this._isActiveGroupedBasesView() && !!this._getActiveTableView();
				if (!checking && ok) this._expandAll();
				return ok;
			},
		});



		this.app.workspace.onLayoutReady(() => {
			if (!this._hasActiveRuntimeEnhancements()) {
				this._cleanupActiveRuntimes();
				return;
			}
			// Clear stale per-element flags from previous plugin loads
			document.querySelectorAll('.internal-embed.bases-embed').forEach(el => {
				delete (el as HTMLElement & { __cgbModelApplied?: boolean }).__cgbModelApplied;
				delete (el as HTMLElement & { __cgbVisibilityWatched?: boolean }).__cgbVisibilityWatched;
			});
			if (this.app.workspace.activeLeaf?.view?.getViewType?.() === 'bases') this._refreshActiveRuntimes();
			else if (this.app.workspace.activeLeaf?.view?.getViewType?.() === 'markdown') this._refreshEmbeddedInActiveLeaf();
			else if (this.app.workspace.activeLeaf?.view?.getViewType?.() === 'canvas') this._refreshCanvasLeaf();
		});

		// Listen for view opens to refresh when switching to grouped views
		// Hide the active grouped view immediately, then restore after config/state is applied.
		this.app.workspace.on('active-leaf-change', () => {
			if (!this._hasActiveRuntimeEnhancements()) {
				this._setInitializingState(false);
				this._cleanupActiveRuntimes();
				return;
			}
			if (this._patchTimer) clearTimeout(this._patchTimer);
			if (this._refreshTimer) clearTimeout(this._refreshTimer);
			this._setInitializingState(true);
			this._patchTimer = setTimeout(async () => {
				await this._loadBaseConfig();
				const leafType = this.app.workspace.activeLeaf?.view?.getViewType?.();
				if (leafType === 'bases' && this._getDirectRuntime()) {
					this._refreshActiveRuntimes();
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

		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			window.setTimeout(async () => {
				if (!this._hasActiveRuntimeEnhancements()) {
					this._cleanupActiveRuntimes();
					return;
				}
				await this._loadBaseConfig();
				const leafType = this.app.workspace.activeLeaf?.view?.getViewType?.();
				if (leafType === 'bases' && file?.path.endsWith('.base') && !this._isActiveGroupedBasesView()) {
					this._cleanupActiveRuntimes();
					await this._reloadActiveBasesLeaf(file);
					return;
				}
				if (leafType === 'bases') this._refreshActiveRuntimes();
				else if (leafType === 'markdown') this._refreshEmbeddedInActiveLeaf();
				else if (leafType === 'canvas') this._refreshCanvasLeaf();
			}, 60);
		}));

		this.registerEvent(this.app.metadataCache.on('changed', (file) => {
			if (!(file instanceof TFile) || file.extension !== 'md') return;
			this._scheduleActiveRuntimeDataRefresh();
		}));

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
			if (!this._hasActiveRuntimeEnhancements()) return;
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
					const leafType = this.app.workspace.activeLeaf?.view?.getViewType?.();
					if (leafType === 'bases' && this._getDirectRuntime()) {
						if (this._shouldSkipDirectRefresh()) return;
						this._refreshActiveRuntimes();
					} else if (leafType === 'markdown') this._refreshEmbeddedInActiveLeaf();
					else if (leafType === 'canvas') this._refreshCanvasLeaf();
					else this._cleanupActiveRuntimes();
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
		if (!this._hasActiveRuntimeEnhancements()) return;
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf) return;
		if (leaf.view?.getViewType() !== 'canvas') return;
		const runtimes: RuntimeContext[] = [];
		const canvasNodeEls = leaf.view.containerEl.querySelectorAll<HTMLElement>('.canvas-node');
		canvasNodeEls.forEach(el => {
			if (!el.querySelector('.bases-view.is-grouped')) return;
			this._applyCanvasNodeCollapse(el);
			const runtime = this._getCanvasRuntime(el);
			if (runtime) runtimes.push(runtime);
		});
		this._patchToolbars(runtimes);
		this._patchHeaders();
		for (const runtime of runtimes) this._patchDraggableRows(runtime);
	}

	private _refreshEmbeddedInActiveLeaf() {
		if (!this._hasActiveRuntimeEnhancements()) return;
		if (this._rerenderingEmbed) return;
		const leaf = this.app.workspace.activeLeaf;
		if (!leaf) return;
		const container = leaf.view?.containerEl as HTMLElement | undefined;
		if (!container) return;
		const embedEls = Array.from(container.querySelectorAll<HTMLElement>('.internal-embed.bases-embed'))
			.filter(embedEl => this._isRenderableEmbedEl(embedEl));
		if (!embedEls.length) return;
		const runtimes: RuntimeContext[] = [];
		embedEls.forEach(embedEl => {
			this._patchEmbedHeaders(embedEl);
			this._applyEmbedCollapse(embedEl);
			this._watchEmbedVisibility(embedEl);
			const runtime = this._getEmbedRuntime(embedEl);
			if (runtime) {
				runtimes.push(runtime);
				this._patchDraggableRows(runtime);
			}
			const notYetInitialized = !(embedEl as HTMLElement & { __cgbModelApplied?: boolean }).__cgbModelApplied;
			if (notYetInitialized && !this._rerenderingEmbed) {
				(embedEl as HTMLElement & { __cgbModelApplied?: boolean }).__cgbModelApplied = true;
				this._applyCollapsedModelToEmbed(embedEl);
			}
		});
		this._patchToolbars(runtimes);
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
		if (!this._getResolvedSettings().enableCollapsibleGroups) return;
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

		const mobileResolved = applyMobileResolvedOverrides(resolved, this.settings, this._isMobileUi());

		this._cachedResolvedSettings = mobileResolved;
		this._baseConfigCacheDirty = false;
		return mobileResolved;
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
		if (this._dataRefreshTimer) clearTimeout(this._dataRefreshTimer);
		if (this._boundPointerUp) document.removeEventListener('pointerup', this._boundPointerUp, true);
		if (this._boundPointerMove) document.removeEventListener('pointermove', this._boundPointerMove, true);
		if (this._boundPointerCancel) document.removeEventListener('pointercancel', this._boundPointerCancel, true);
		if (this._boundDragOver) document.removeEventListener('dragover', this._boundDragOver, true);
		if (this._boundDrop) document.removeEventListener('drop', this._boundDrop, true);
		if (this._boundDragEnd) document.removeEventListener('dragend', this._boundDragEnd, true);
		this._styleEl?.remove();
		this._headerKeyCache.clear();
		document.querySelectorAll('.cgb-toolbar, .cgb-chevron, .cgb-count-badge, .cgb-row-drag-handle').forEach(el => el.remove());
		document.querySelectorAll('[data-cgb-patched],[data-cgb-container-patched],[data-cgb-drop-target],[data-cgb-row-draggable],[data-cgb-row-drag-cell]').forEach(el => {
			el.removeAttribute('data-cgb-patched');
			el.removeAttribute('data-cgb-container-patched');
			el.removeAttribute('data-cgb-drop-target');
			el.removeAttribute('data-cgb-row-draggable');
			el.removeAttribute('data-cgb-row-drag-cell');
		});
		this._clearTouchDragState();
		this._clearDropTargetHighlight();
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
.bases-table.is-cgb-drop-target { transition: background-color 120ms ease, box-shadow 120ms ease; }
.bases-table.is-cgb-drop-active {
  background: color-mix(in srgb, var(--background-modifier-hover) 65%, transparent);
  box-shadow: inset 0 0 0 1px var(--interactive-accent);
}
.bases-tr[data-cgb-row-draggable="true"] { position: absolute; }
.bases-td[data-cgb-row-drag-cell="true"] > .bases-table-cell { padding-left: 22px; }
.bases-td[data-cgb-row-drag-cell="true"] .metadata-property-value,
.bases-td[data-cgb-row-drag-cell="true"] .metadata-input-longtext,
.bases-td[data-cgb-row-drag-cell="true"] .metadata-input-text {
  padding-left: 22px;
  box-sizing: border-box;
}
.cgb-row-drag-handle {
  position: absolute;
  inset-inline-start: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 18px;
  color: var(--text-muted);
  opacity: 0.9;
  cursor: grab;
  z-index: 5;
  pointer-events: auto;
  background: var(--background-primary);
  border-radius: 4px;
  touch-action: none;
  -webkit-user-select: none;
  user-select: none;
}
.cgb-row-drag-handle:hover {
  color: var(--text-normal);
  opacity: 1;
}
.cgb-row-drag-handle:active { cursor: grabbing; }
.cgb-row-drag-handle.is-cgb-active {
  color: var(--text-normal);
  background: var(--background-modifier-hover);
  border-radius: 4px;
}
.cgb-row-drag-handle svg, .cgb-row-drag-handle path { pointer-events: none; }
.bases-tr.is-cgb-row-dragging { opacity: 0.45; }
body.is-cgb-dragging,
body.is-cgb-dragging * {
  cursor: grabbing !important;
}
.cgb-drag-preview {
  position: fixed;
  top: -9999px;
  left: -9999px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--background-primary);
  color: var(--text-normal);
  border: 1px solid var(--interactive-accent);
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  font-size: var(--font-ui-small);
  white-space: nowrap;
  pointer-events: none;
  z-index: 9999;
}
.cgb-drag-preview-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--interactive-accent);
  flex-shrink: 0;
}
.cgb-settings-notice {
  margin: 0 0 18px;
  padding: 18px 20px;
  border-radius: 16px;
  background: color-mix(in srgb, var(--background-secondary) 82%, var(--background-primary));
  color: var(--text-normal);
}
.cgb-settings-notice-title {
  margin: 0 0 6px;
  font-size: var(--font-ui-medium);
  font-weight: var(--font-semibold);
}
.cgb-settings-notice-text {
  margin: 0;
  color: var(--text-muted);
  line-height: 1.5;
}
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
			if (this._touchDragState?.pointerId === e.pointerId) {
				const tableEl = this._touchDragState.activated ? this._getDropTargetTableAtPoint(e.clientX, e.clientY) : null;
				const shouldHandleDrop = !!tableEl && this._isTableValidDropTarget(tableEl);
				e.preventDefault();
				e.stopPropagation();
				this._clearTouchDragState(false);
				if (shouldHandleDrop) void this._handleRowDrop(tableEl);
				else this._clearDragState();
				return;
			}
			if (this._dragState || this._dragMoveInFlight || Date.now() < this._suppressHeaderToggleUntil) return;
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

		this._boundPointerMove = (e: PointerEvent) => {
			const touchDragState = this._touchDragState;
			if (!touchDragState || touchDragState.pointerId !== e.pointerId) return;
			touchDragState.lastX = e.clientX;
			touchDragState.lastY = e.clientY;
			if (!touchDragState.activated) {
				const moved = Math.hypot(e.clientX - touchDragState.startX, e.clientY - touchDragState.startY);
				if (moved > 8) this._clearTouchDragState();
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			this._moveTouchDragPreview(e.clientX, e.clientY);
			const tableEl = this._getDropTargetTableAtPoint(e.clientX, e.clientY);
			if (!tableEl || !this._isTableValidDropTarget(tableEl)) {
				this._clearDropTargetHighlight();
				return;
			}
			this._setDropTargetHighlight(tableEl);
		};
		document.addEventListener('pointermove', this._boundPointerMove, true);

		this._boundPointerCancel = (e: PointerEvent) => {
			if (this._touchDragState?.pointerId !== e.pointerId) return;
			this._clearTouchDragState();
			this._clearDragState();
		};
		document.addEventListener('pointercancel', this._boundPointerCancel, true);

		this._boundDragOver = (e: DragEvent) => {
			if (!this._isDragAndDropEnabled() || !this._dragState) return;
			const target = e.target as HTMLElement | null;
			const tableEl = target?.closest('.bases-table[data-cgb-drop-target="true"]') as HTMLElement | null;
			if (!tableEl || !this._isTableValidDropTarget(tableEl)) {
				this._clearDropTargetHighlight();
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
			this._setDropTargetHighlight(tableEl);
		};
		document.addEventListener('dragover', this._boundDragOver, true);

		this._boundDrop = (e: DragEvent) => {
			if (!this._isDragAndDropEnabled() || !this._dragState) return;
			const target = e.target as HTMLElement | null;
			const tableEl = target?.closest('.bases-table[data-cgb-drop-target="true"]') as HTMLElement | null;
			this._suppressHeaderToggleUntil = Date.now() + 250;
			if (!tableEl || !this._isTableValidDropTarget(tableEl)) {
				this._clearDropTargetHighlight();
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			void this._handleRowDrop(tableEl);
		};
		document.addEventListener('drop', this._boundDrop, true);

		this._boundDragEnd = () => {
			this._clearDragState();
		};
		document.addEventListener('dragend', this._boundDragEnd, true);
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

	private _ensureRuntimeUpdateWrapper(runtime: RuntimeContext) {
		const table = runtime.table;
		const mode = `${runtime.kind}:${runtime.sourceKey}`;
		if (table.__cgbWrappedMode === mode && table.__cgbOriginalUpdateVirtualDisplay) return;
		const original = table.__cgbOriginalUpdateVirtualDisplay ?? this._getNativeUpdateVirtualDisplay(table);
		if (!original) return;
		table.__cgbOriginalUpdateVirtualDisplay = original;
		table.__cgbWrappedMode = mode;
		table.updateVirtualDisplay = (() => {
			if (table.data && this._isGloballyEnabled()) {
				table.data.groupedDataCache = this._buildCollapsedGroups(table, runtime.sourceKey, this._getResolvedSettings());
			}
			const result = table.__cgbOriginalUpdateVirtualDisplay?.();
			runtime.afterRender();
			this._patchDraggableRows(runtime);
			if (runtime.kind !== 'direct') {
				this._patchToolbars();
				this._patchHeaders();
			}
			return result;
		}) as () => void;
	}

	private _applyCollapsedModel(runtime: RuntimeContext) {
		const resolved = this._getResolvedSettings();
		if (!resolved.enableCollapsibleGroups) {
			this._cleanupRuntimeContext(runtime);
			this._patchDraggableRows(runtime);
			return;
		}
		if (!this._isGroupedTableView(runtime.table)) {
			this._cleanupRuntimeContext(runtime);
			return;
		}
		this._ensureRuntimeUpdateWrapper(runtime);
		if (!runtime.table.data) return;
		runtime.table.data.groupedDataCache = this._buildCollapsedGroups(runtime.table, runtime.sourceKey, resolved);
		runtime.table.display?.();
		runtime.table.updateVirtualDisplay?.();
		this._syncRuntimeDom(runtime, resolved);
		this._patchDraggableRows(runtime);
	}

	private _getWritableGroupField(table: BasesTableView): WritableGroupField | null {
		return getWritableGroupField(table);
	}

	private _patchDraggableRows(runtime: RuntimeContext) {
		const dragEnabled = this._isDragAndDropEnabled();
		const writableField = dragEnabled ? this._getWritableGroupField(runtime.table) : null;
		if (!writableField) {
			syncDragDecorations(runtime.viewEl, runtime.getHeaders(), [], false);
			return;
		}

		const rows = [];
		for (const row of runtime.table.rows ?? []) {
			const rowEl = row.el;
			const file = row.entry?.file;
			if (!rowEl || !(rowEl instanceof HTMLElement) || !file) continue;
			if (!runtime.viewEl.contains(rowEl)) continue;
			rows.push({
				rowEl,
				createHandle: () => {
					const handle = document.createElement('span');
					handle.className = 'cgb-row-drag-handle';
					handle.draggable = true;
					handle.setAttribute('aria-label', 'Move row to another group');
					handle.setAttribute('title', 'Drag to move row to another group');
					handle.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01"/></svg>`;
				handle.addEventListener('dragstart', event => {
					this._onRowDragStart(event, runtime, rowEl, file, handle);
				});
				handle.addEventListener('dragend', () => {
					this._clearDragState();
				});
				handle.addEventListener('pointerdown', event => {
					this._onRowHandlePointerDown(event, runtime, rowEl, file, handle);
				});
					return handle;
				},
			});
		}
		syncDragDecorations(runtime.viewEl, runtime.getHeaders(), rows, true);
	}

	private _onRowDragStart(event: DragEvent, runtime: RuntimeContext, rowEl: HTMLElement, file: TFile, handleEl: HTMLElement) {
		if (!this._isDragAndDropEnabled() || this._dragMoveInFlight) {
			event.preventDefault();
			return;
		}
		const writableField = this._getWritableGroupField(runtime.table);
		if (!writableField) {
			event.preventDefault();
			return;
		}
		const sourceGroupValue = this._normalizeGroupValue(
			rowEl.closest('.bases-table')?.querySelector('.bases-group-value')?.textContent?.trim(),
		);
		this._clearDragState();
		this._dragState = {
			runtimeKind: runtime.kind,
			runtimeSourceKey: runtime.sourceKey,
			file,
			rowEl,
			handleEl,
			sourceGroupValue,
			dragPreviewEl: null,
		};
		document.body.classList.add('is-cgb-dragging');
		rowEl.classList.add('is-cgb-row-dragging');
		handleEl.classList.add('is-cgb-active');
		if (event.dataTransfer) {
			event.dataTransfer.effectAllowed = 'move';
			event.dataTransfer.setData('text/plain', file.path);
			const dragPreviewEl = this._createDragPreview(file.basename, sourceGroupValue);
			if (dragPreviewEl) {
				this._dragState.dragPreviewEl = dragPreviewEl;
				event.dataTransfer.setDragImage(dragPreviewEl, 14, 14);
			}
		}
	}

	private _onRowHandlePointerDown(event: PointerEvent, runtime: RuntimeContext, rowEl: HTMLElement, file: TFile, handleEl: HTMLElement) {
		if (!this._shouldUseTouchDrag(event) || !this._isDragAndDropEnabled() || this._dragMoveInFlight) return;
		const writableField = this._getWritableGroupField(runtime.table);
		if (!writableField) return;
		this._clearTouchDragState();
		const sourceGroupValue = this._normalizeGroupValue(
			rowEl.closest('.bases-table')?.querySelector('.bases-group-value')?.textContent?.trim(),
		);
		const touchDragState: TouchDragState = {
			pointerId: event.pointerId,
			runtime,
			file,
			rowEl,
			handleEl,
			sourceGroupValue,
			startX: event.clientX,
			startY: event.clientY,
			lastX: event.clientX,
			lastY: event.clientY,
			activated: false,
			holdTimer: null,
		};
		touchDragState.holdTimer = window.setTimeout(() => {
			if (this._touchDragState?.pointerId !== touchDragState.pointerId) return;
			this._activateTouchDrag();
		}, 180);
		this._touchDragState = touchDragState;
		handleEl.setPointerCapture?.(event.pointerId);
	}

	private _shouldUseTouchDrag(event: PointerEvent): boolean {
		if (event.pointerType === 'touch') return true;
		return window.matchMedia?.('(pointer: coarse)').matches ?? false;
	}

	private _activateTouchDrag() {
		const touchDragState = this._touchDragState;
		if (!touchDragState || touchDragState.activated) return;
		touchDragState.activated = true;
		this._clearDragState();
		this._dragState = {
			runtimeKind: touchDragState.runtime.kind,
			runtimeSourceKey: touchDragState.runtime.sourceKey,
			file: touchDragState.file,
			rowEl: touchDragState.rowEl,
			handleEl: touchDragState.handleEl,
			sourceGroupValue: touchDragState.sourceGroupValue,
			dragPreviewEl: this._createDragPreview(touchDragState.file.basename, touchDragState.sourceGroupValue),
		};
		document.body.classList.add('is-cgb-dragging');
		touchDragState.rowEl.classList.add('is-cgb-row-dragging');
		touchDragState.handleEl.classList.add('is-cgb-active');
		this._moveTouchDragPreview(touchDragState.lastX, touchDragState.lastY);
	}

	private _moveTouchDragPreview(x: number, y: number) {
		const dragPreviewEl = this._dragState?.dragPreviewEl;
		if (!dragPreviewEl) return;
		dragPreviewEl.style.left = `${x + 12}px`;
		dragPreviewEl.style.top = `${y - 12}px`;
	}

	private _getDropTargetTableAtPoint(x: number, y: number): HTMLElement | null {
		const target = document.elementFromPoint(x, y) as HTMLElement | null;
		return target?.closest('.bases-table[data-cgb-drop-target="true"]') as HTMLElement | null;
	}

	private _clearTouchDragState(clearDragState = true) {
		if (!this._touchDragState) return;
		if (this._touchDragState.holdTimer) clearTimeout(this._touchDragState.holdTimer);
		this._touchDragState.handleEl.releasePointerCapture?.(this._touchDragState.pointerId);
		this._touchDragState = null;
		if (clearDragState) this._clearDragState();
	}

	private _createDragPreview(fileName: string, sourceGroupValue: string): HTMLElement | null {
		const previewEl = document.createElement('div');
		previewEl.className = 'cgb-drag-preview';
		previewEl.innerHTML = `<span class="cgb-drag-preview-dot"></span><span>Moving ${fileName} from ${sourceGroupValue}</span>`;
		document.body.appendChild(previewEl);
		return previewEl;
	}

	private _getRuntimeForElement(el: HTMLElement): RuntimeContext | null {
		const embedEl = el.closest('.internal-embed.bases-embed') as HTMLElement | null;
		if (embedEl) return this._getEmbedRuntime(embedEl);
		const canvasNodeEl = el.closest('.canvas-node') as HTMLElement | null;
		if (canvasNodeEl) return this._getCanvasRuntime(canvasNodeEl);
		return this._getDirectRuntime();
	}

	private _isTableValidDropTarget(tableEl: HTMLElement): boolean {
		if (!this._isDragAndDropEnabled()) return false;
		const runtime = this._getRuntimeForElement(tableEl);
		if (!runtime || !this._dragState) return false;
		return runtime.kind === this._dragState.runtimeKind &&
			runtime.sourceKey === this._dragState.runtimeSourceKey &&
			runtime.viewEl.contains(tableEl);
	}

	private _setDropTargetHighlight(tableEl: HTMLElement) {
		if (this._hoveredDropTable === tableEl) return;
		if (this._hoveredDropTable) this._hoveredDropTable.classList.remove('is-cgb-drop-active');
		this._hoveredDropTable = tableEl;
		tableEl.classList.add('is-cgb-drop-active');
	}

	private _clearDropTargetHighlight() {
		if (!this._hoveredDropTable) return;
		this._hoveredDropTable.classList.remove('is-cgb-drop-active');
		this._hoveredDropTable = null;
	}

	private _clearDragState() {
		this._clearDropTargetHighlight();
		document.body.classList.remove('is-cgb-dragging');
		this._dragState?.handleEl?.classList.remove('is-cgb-active');
		this._dragState?.dragPreviewEl?.remove();
		if (this._dragState?.rowEl) this._dragState.rowEl.classList.remove('is-cgb-row-dragging');
		this._dragState = null;
	}

	private _setGroupedFrontmatterValue(frontmatter: Record<string, unknown>, key: string, groupValue: string) {
		if (groupValue === 'None') delete frontmatter[key];
		else frontmatter[key] = groupValue;
	}

	private _invalidateGroupedCaches(table: BasesTableView) {
		if (table.data) table.data.groupedDataCache = null;
		delete table.__cgbOriginalGroupedData;
		delete table.__cgbGroupCountMap;
	}

	private _refreshRuntimeAfterMove(runtime: RuntimeContext) {
		if (!runtime) return;
		this._invalidateGroupedCaches(runtime.table);
		runtime.table.queryController?.update?.();
		runtime.table.onDataUpdated?.();
		window.setTimeout(() => {
			if (runtime.kind === 'embed') {
				this._refreshEmbeddedInActiveLeaf();
				return;
			}
			if (runtime.kind === 'canvas') {
				this._refreshCanvasLeaf();
				return;
			}
			this._refreshActiveRuntimes();
		}, 80);
	}

	private _scheduleActiveRuntimeDataRefresh() {
		if (!this._hasActiveRuntimeEnhancements()) return;
		if (this._dataRefreshTimer) clearTimeout(this._dataRefreshTimer);
		this._dataRefreshTimer = window.setTimeout(() => {
			this._dataRefreshTimer = null;
			const runtimes = this._getActiveRuntimes();
			if (!runtimes.length) return;
			for (const runtime of runtimes) {
				this._invalidateGroupedCaches(runtime.table);
				if (runtime.kind !== 'direct') {
					runtime.table.queryController?.update?.();
					runtime.table.onDataUpdated?.();
				}
			}
			window.setTimeout(async () => {
				const leafType = this.app.workspace.activeLeaf?.view?.getViewType?.();
				if (leafType === 'bases') {
					const baseFile = (this.app.workspace.activeLeaf?.view as { file?: TFile } | undefined)?.file ?? null;
					await this._reloadActiveBasesLeaf(baseFile);
					this._refreshActiveRuntimes();
				}
				else if (leafType === 'markdown') this._refreshEmbeddedInActiveLeaf();
				else if (leafType === 'canvas') this._refreshCanvasLeaf();
			}, 80);
		}, 80);
	}

	private async _handleRowDrop(tableEl: HTMLElement) {
		if (!this._isDragAndDropEnabled()) {
			this._clearDragState();
			return;
		}
		const dragState = this._dragState;
		const runtime = this._getRuntimeForElement(tableEl);
		if (!dragState || !runtime || !this._isTableValidDropTarget(tableEl)) {
			this._clearDragState();
			return;
		}
		const writableField = this._getWritableGroupField(runtime.table);
		if (!writableField) {
			this._clearDragState();
			return;
		}
		const targetGroupValue = this._normalizeGroupValue(tableEl.querySelector('.bases-group-value')?.textContent?.trim());
		if (targetGroupValue === dragState.sourceGroupValue) {
			this._clearDragState();
			return;
		}
		if (this._dragMoveInFlight) return;
		this._dragMoveInFlight = true;
		this._suppressHeaderToggleUntil = Date.now() + 250;
		try {
			await this.app.fileManager.processFrontMatter(dragState.file, frontmatter => {
				this._setGroupedFrontmatterValue(frontmatter, writableField.frontmatterKey, targetGroupValue);
			});
			this._refreshRuntimeAfterMove(runtime);
		} catch (error) {
			console.error('[CGBDrag] Failed to move row between groups:', error);
			new Notice('Failed to move row to the selected group.');
		} finally {
			this._dragMoveInFlight = false;
			this._clearDragState();
		}
	}

	private _syncRuntimeDom(runtime: RuntimeContext, resolved: ResolvedConfig) {
		this._applyCollapsedDomState(runtime, resolved);
		runtime.afterRender();
		if (runtime.kind === 'direct') {
			requestAnimationFrame(() => {
				this._applyCollapsedDomState(runtime, resolved);
				runtime.afterRender();
			});
		}
	}

	private _applyCollapsedDomState(runtime: RuntimeContext, resolved: ResolvedConfig) {
		const headers = runtime.getHeaders();
		for (const header of headers) {
			const groupValue = this._normalizeGroupValue(header.querySelector('.bases-group-value')?.textContent?.trim());
			const key = `${runtime.sourceKey}::${groupValue}`;
			const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || this._collapsedKeys.has(key));
			const tableEl = header.closest('.bases-table') as HTMLElement | null;
			if (tableEl) {
				if (collapsed) tableEl.setAttribute('data-cgb-collapsed', 'true');
				else tableEl.removeAttribute('data-cgb-collapsed');
				const tbody = tableEl.querySelector<HTMLElement>(':scope > .bases-tbody');
				if (tbody) {
					if (collapsed) {
						tbody.style.height = '0px';
					} else if (runtime.kind === 'direct') {
						const groupCount = this._groupEntryCount(runtime.table, groupValue);
						tbody.style.height = `${this._groupRowHeight(tbody) * groupCount}px`;
					} else {
						tbody.style.height = '';
					}
				}
			}
		}
	}

	private _groupEntryCount(table: BasesTableView, groupValue: string): number {
		const countMap = table.__cgbGroupCountMap ?? {};
		if (groupValue in countMap) return countMap[groupValue] ?? 0;
		const original = table.__cgbOriginalGroupedData ?? [];
		const group = original.find(item => this._normalizeGroupValue(this._groupValue(item)) === groupValue);
		return group?.entries.length ?? 0;
	}

	private _groupRowHeight(tbody: HTMLElement): number {
		const computed = getComputedStyle(tbody);
		const cssValue = computed.getPropertyValue('--bases-table-row-height').trim();
		const parsed = parseFloat(cssValue);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
	}

	private _refreshAllGroupedViews() {
		this._refreshActiveRuntimes();
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

	private _patchToolbars(runtimes: RuntimeContext[] = this._getActiveRuntimes()) {
		const containers = Array.from(new Set(runtimes.map(runtime => runtime.viewEl)));
		const removeToolbars = () => {
			for (const container of containers) {
				container.parentElement?.querySelector('.cgb-toolbar')?.remove();
				container.removeAttribute('data-cgb-container-patched');
			}
		};
		if (!this._isRuntimeEnabled()) {
			removeToolbars();
			return;
		}
		const resolved = this._getResolvedSettings();
		if (!resolved.showToolbarButtons) {
			removeToolbars();
			return;
		}
		if (!resolved.enableCollapsibleGroups) {
			removeToolbars();
			return;
		}

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
		if (!this._isRuntimeEnabled()) return;
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
				if (this._getResolvedSettings().showGroupCounts) {
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
		if (!this._isRuntimeEnabled()) return;
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
		if (!this._isRuntimeEnabled() || !resolved.enableCollapsibleGroups) return;

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
				// Zero out tbody inline height when collapsed so Bases positions next group
				// immediately below the header (not after the full virtual scroll height)
				const tbody = tableEl.querySelector<HTMLElement>(':scope > .bases-tbody');
				if (tbody) {
					if (collapsed) tbody.style.height = '0px';
					// When expanding, let Bases' updateVirtualDisplay restore the correct height
				}
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
		const runtime = this._getCanvasRuntime(canvasNodeEl);

		const table = runtime?.table ?? this._getCanvasTableView(canvasNodeEl);
		if (!table?.data) return;
		const sourceGroups = this._getOriginalGroupedData(table);

		table.data.groupedDataCache = sourceGroups.map(group => {
			const clone = { ...group } as BasesGroup;
			const groupValue = this._normalizeGroupValue(this._groupValue(group));
			const key = filePath ? `${filePath}::${groupValue}` : this._stateKey(groupValue);
			const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || this._collapsedKeys.has(key));
			clone.entries = collapsed ? [] : group.entries.slice();
			return clone;
		});

		if (runtime) this._ensureRuntimeUpdateWrapper(runtime);
		table.display?.();
		table.updateVirtualDisplay?.();
		this._reflowCanvasNode(canvasNodeEl);

		// Re-patch headers after display() re-creates them
		requestAnimationFrame(() => {
			this._reflowCanvasNode(canvasNodeEl);
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
		this._repackTablesByMeasuredHeight(tableContainer, tables);
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
		const sourceGroups = this._getOriginalGroupedData(table);

		table.data.groupedDataCache = sourceGroups.map(group => {
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
		table.data.groupedDataCache = sourceGroups.map(group => {
			const clone = { ...group } as BasesGroup;
			const groupValue = this._normalizeGroupValue(this._groupValue(group));
			const key = `${src}::${groupValue}`;
			const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || this._collapsedKeys.has(key));
			clone.entries = collapsed ? [] : group.entries.slice();
			return clone;
		});
		table.display?.();
		table.updateVirtualDisplay?.();

		// Patch headers after display() re-creates them, fix container height and repack
		requestAnimationFrame(() => {
			this._patchEmbedHeaders(embedEl);
			this._patchToolbars();
			this._fixEmbedContainerHeight(embedEl, table);
			this._repackEmbedTables(embedEl);
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
			if (this.data) {
				const sourceGroups = self._getOriginalGroupedData(this);
				this.data.groupedDataCache = sourceGroups.map(group => {
					const clone = { ...group } as BasesGroup;
					const groupValue = self._normalizeGroupValue(self._groupValue(group));
					const key = `${src}::${groupValue}`;
					const collapsed = resolved.enableCollapsibleGroups && (resolved.collapseAllByDefault || self._collapsedKeys.has(key));
					clone.entries = collapsed ? [] : group.entries.slice();
					return clone;
				});
			}
				const result = origUpdate();
			// After virtual display runs, repack table top positions using actual heights
			requestAnimationFrame(() => { self._repackEmbedTables(embedEl); });
			return result;
		};
	}

	private _repackEmbedTables(embedEl: HTMLElement) {
		const container = embedEl.querySelector<HTMLElement>('.bases-table-container');
		if (!container) return;
		const tables = Array.from(container.querySelectorAll<HTMLElement>(':scope > .bases-table'));
		if (!tables.length) return;
		let top = 0;
		for (const t of tables) {
			t.style.top = `${top}px`;
			top += t.offsetHeight;
		}
		container.style.height = `${top}px`;
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
		const runtime = this._getDirectRuntime();
		if (!runtime) return;

		// Clear the cached original data to force re-fetch from source
		delete runtime.table.__cgbOriginalGroupedData;
		delete runtime.table.__cgbGroupCountMap;

		// Use DOM to find ALL group headers, not just those in the virtual data
		// This ensures we collapse all groups even with virtual scrolling
		const headers = runtime.getHeaders();
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
				this._applyCollapsedModel(runtime);
				this._patchHeaders();
				this._scrollActiveViewToTop();
			});
		}
	}

	private _expandAll() {
		const resolved = this._getResolvedSettings();
		const runtime = this._getDirectRuntime();
		if (!runtime) return;

		// Clear the cached original data to force re-fetch from source
		delete runtime.table.__cgbOriginalGroupedData;
		delete runtime.table.__cgbGroupCountMap;

		// Use DOM to find ALL group headers, not just those in the virtual data
		// This ensures we expand all groups even with virtual scrolling
		const headers = runtime.getHeaders();
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
				this._applyCollapsedModel(runtime);
				this._patchHeaders();
				this._scrollActiveViewToTop();
			});
		}
	}

	private _refreshAfterStateChange(expandedKey?: string) {
		const runtime = this._getDirectRuntime();
		if (!runtime) return;
		const table = this._getActiveTableView();
		const previousScrollTop = table?.scrollEl?.scrollTop ?? 0;
		this._applyCollapsedModel(runtime);
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
		const runtime = this._getDirectRuntime();
		if (!runtime) return;
		this._applyCollapsedModel(runtime);
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
			requestAnimationFrame(() => {
				self._fixGroupGaps(this);
			});
			return result;
		};
	}

	private _fixGroupGaps(table: BasesTableView) {
		const container = table.containerEl;
		if (!container) return;
		const tables = container.querySelectorAll<HTMLElement>(':scope > .bases-table');
		this._repackTablesByMeasuredHeight(container, tables);
	}

	private _repackTablesByMeasuredHeight(container: HTMLElement, tables: NodeListOf<HTMLElement> | HTMLElement[]) {
		let top = 0;
		for (let i = 0; i < tables.length; i++) {
			const tableEl = tables[i];
			tableEl.style.top = `${top}px`;
			const measuredHeight = tableEl.offsetHeight || tableEl.getBoundingClientRect().height;
			if (measuredHeight > 0) {
				top += measuredHeight;
				continue;
			}
			const heading = tableEl.querySelector<HTMLElement>(':scope > .bases-group-heading');
			const tbody = tableEl.querySelector<HTMLElement>(':scope > .bases-tbody');
			top += (heading?.getBoundingClientRect().height ?? 30) + (tbody?.getBoundingClientRect().height ?? 0);
		}
		container.style.height = `${top}px`;
	}

	private _resetGroupedDataCache() {
		const table = this._getActiveTableView();
		if (!table?.data) return;
		table.data.groupedDataCache = null;
		delete table.__cgbOriginalGroupedData;
		delete table.__cgbGroupCountMap;
	}

	private _entryIdentity(entry: unknown): string {
		const maybeEntry = entry as { file?: { path?: string }; frontmatter?: { title?: string } };
		return maybeEntry?.file?.path ?? maybeEntry?.frontmatter?.title ?? '';
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
				if (this._groupValue(group) !== this._groupValue(next) || group.entries.length !== next.entries.length) {
					return true;
				}
				return group.entries.some((entry, entryIndex) => {
					return this._entryIdentity(entry) !== this._entryIdentity(next.entries[entryIndex]);
				});
			});

		if (needsRefresh) {
			table.__cgbOriginalGroupedData = source;
			table.__cgbGroupCountMap = Object.fromEntries(source.map(group => [this._groupValue(group), group.entries.length]));
		} else if (!table.__cgbGroupCountMap) {
			const countSource = table.__cgbOriginalGroupedData ?? source;
			table.__cgbGroupCountMap = Object.fromEntries(countSource.map(group => [this._groupValue(group), group.entries.length]));
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
		if (!this._isFeatureEnabledOnCurrentDevice(this.settings.enableDragAndDrop, this.settings.enableDragAndDropMobile)) {
			this._clearDragState();
			this._removeDragDomState();
		}
		if (!this._hasActiveRuntimeEnhancements()) {
			await this._disableRuntime();
		} else {
			this._syncCollapsedKeysFromFoldState();
		}
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

	private _refreshViews() {
		(this.plugin as unknown as { _refreshActiveRuntimes: () => void })._refreshActiveRuntimes();
	}

	private async _saveAndRefresh(redisplay = false) {
		await this.plugin.saveSettings();
		this._refreshViews();
		if (redisplay) this.display();
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		const noticeEl = containerEl.createDiv({ cls: 'cgb-settings-notice' });
		noticeEl.createEl('p', {
			cls: 'cgb-settings-notice-title',
			text: 'Restart May Be Needed',
		});
		noticeEl.createEl('p', {
			cls: 'cgb-settings-notice-text',
			text: 'Some setting changes may require restarting Obsidian to fully take effect.',
		});

		containerEl.createEl('h3', { text: 'Toolbar' });

		new Setting(containerEl)
			.setName('Show feature toolbar')
			.setDesc('Show feature buttons above grouped Bases views.')
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.showToolbarButtons).onChange(async value => {
					this.plugin.settings.showToolbarButtons = value;
					await this._saveAndRefresh(true);
				}),
			);

		new Setting(containerEl)
			.setName('Enable toolbar on mobile')
			.setDesc('Requires the desktop toolbar toggle to be enabled.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.showToolbarButtonsMobile)
					.setDisabled(!this.plugin.settings.showToolbarButtons)
					.onChange(async value => {
						this.plugin.settings.showToolbarButtonsMobile = value;
						await this._saveAndRefresh();
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
						await this._saveAndRefresh();
					}),
			);

		containerEl.createEl('h3', { text: 'Collapsing Groups' });

			new Setting(containerEl)
				.setName('Apply collapsible groups by default')
				.setDesc('Makes grouped Bases views collapsible unless a specific view overrides that default.')
				.addToggle(toggle =>
					toggle.setValue(this.plugin.settings.enableCollapsibleGroups).onChange(async value => {
						this.plugin.settings.enableCollapsibleGroups = value;
						await this._saveAndRefresh(true);
					}),
				);

			new Setting(containerEl)
				.setName('Enable collapsible groups on mobile')
				.setDesc('Requires desktop collapsible groups to be enabled.')
				.addToggle(toggle =>
					toggle
						.setValue(this.plugin.settings.enableCollapsibleGroupsMobile)
						.setDisabled(!this.plugin.settings.enableCollapsibleGroups)
						.onChange(async value => {
							this.plugin.settings.enableCollapsibleGroupsMobile = value;
							await this._saveAndRefresh();
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
						await this._saveAndRefresh(true);
					}),
				);

		new Setting(containerEl)
			.setName('Show counts on mobile')
			.setDesc('Requires desktop group counts to be enabled.')
				.addToggle(toggle =>
					toggle
						.setValue(this.plugin.settings.showGroupCountsMobile)
						.setDisabled(!this.plugin.settings.showGroupCounts)
						.onChange(async value => {
							this.plugin.settings.showGroupCountsMobile = value;
						await this._saveAndRefresh();
					}),
			);

		containerEl.createEl('h3', { text: 'Drag and Drop Support' });

		new Setting(containerEl)
			.setName('Enable drag and drop between groups')
			.setDesc('Show row drag handles and allow moving rows between groups in grouped Bases views.')
			.addToggle(toggle =>
				toggle.setValue(this.plugin.settings.enableDragAndDrop).onChange(async value => {
					this.plugin.settings.enableDragAndDrop = value;
					await this._saveAndRefresh(true);
				}),
			);

		new Setting(containerEl)
			.setName('Enable drag and drop on mobile')
			.setDesc('Requires desktop drag and drop to be enabled. Uses press and hold to activate.')
			.addToggle(toggle =>
				toggle
					.setValue(this.plugin.settings.enableDragAndDropMobile)
					.setDisabled(!this.plugin.settings.enableDragAndDrop)
					.onChange(async value => {
						this.plugin.settings.enableDragAndDropMobile = value;
						await this._saveAndRefresh();
					}),
			);

		}
	}
