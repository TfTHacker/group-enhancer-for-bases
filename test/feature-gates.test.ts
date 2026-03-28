import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { applyMobileResolvedOverrides, isFeatureEnabledOnCurrentDevice } from '../src/feature-gates';

test('feature stays enabled on desktop even when mobile override is off', () => {
	assert.equal(isFeatureEnabledOnCurrentDevice(true, false, false), true);
});

test('feature is disabled on mobile when mobile override is off', () => {
	assert.equal(isFeatureEnabledOnCurrentDevice(true, false, true), false);
});

test('desktop toggle off forces feature off everywhere', () => {
	assert.equal(isFeatureEnabledOnCurrentDevice(false, true, false), false);
	assert.equal(isFeatureEnabledOnCurrentDevice(false, true, true), false);
});

test('mobile overrides affect resolved settings only in mobile mode', () => {
	const resolved = {
		enableCollapsibleGroups: true,
		showToolbarButtons: true,
		showGroupCounts: true,
	};

	assert.deepEqual(
		applyMobileResolvedOverrides(resolved, {
			enableCollapsibleGroupsMobile: false,
			showToolbarButtonsMobile: false,
			showGroupCountsMobile: false,
		}, false),
		resolved,
	);

	assert.deepEqual(
		applyMobileResolvedOverrides(resolved, {
			enableCollapsibleGroupsMobile: false,
			showToolbarButtonsMobile: true,
			showGroupCountsMobile: false,
		}, true),
		{
			enableCollapsibleGroups: false,
			showToolbarButtons: true,
			showGroupCounts: false,
		},
	);
});
