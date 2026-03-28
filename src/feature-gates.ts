export type MobileAwareResolvedSettings = {
	enableCollapsibleGroups: boolean;
	showToolbarButtons: boolean;
	showGroupCounts: boolean;
};

export type MobileFeatureSettings = {
	enableCollapsibleGroupsMobile: boolean;
	showToolbarButtonsMobile: boolean;
	showGroupCountsMobile: boolean;
};

export function isFeatureEnabledOnCurrentDevice(enabled: boolean, mobileEnabled: boolean, isMobile: boolean): boolean {
	if (!enabled) return false;
	if (!isMobile) return true;
	return mobileEnabled;
}

export function applyMobileResolvedOverrides<T extends MobileAwareResolvedSettings>(
	resolved: T,
	mobileSettings: MobileFeatureSettings,
	isMobile: boolean,
): T {
	if (!isMobile) return { ...resolved };
	return {
		...resolved,
		enableCollapsibleGroups: resolved.enableCollapsibleGroups && mobileSettings.enableCollapsibleGroupsMobile,
		showToolbarButtons: resolved.showToolbarButtons && mobileSettings.showToolbarButtonsMobile,
		showGroupCounts: resolved.showGroupCounts && mobileSettings.showGroupCountsMobile,
	};
}
