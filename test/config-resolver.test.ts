import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ConfigResolver } from '../src/config-resolver';

test('ConfigResolver applies base defaults over global settings', () => {
	const resolved = ConfigResolver.resolve({
		enableCollapsibleGroups: true,
		rememberFoldState: true,
		collapseAllByDefault: false,
		showToolbarButtons: true,
		toolbarButtonDisplay: 'both',
		showGroupCounts: true,
	}, {
		defaults: {
			showToolbarButtons: false,
			showGroupCounts: false,
		},
	}, undefined);

	assert.equal(resolved.showToolbarButtons, false);
	assert.equal(resolved.showGroupCounts, false);
	assert.equal(resolved.enableCollapsibleGroups, true);
});

test('ConfigResolver applies view overrides over base defaults', () => {
	const resolved = ConfigResolver.resolve({
		enableCollapsibleGroups: true,
		rememberFoldState: true,
		collapseAllByDefault: false,
		showToolbarButtons: true,
		toolbarButtonDisplay: 'both',
		showGroupCounts: true,
	}, {
		defaults: {
			showToolbarButtons: false,
			showGroupCounts: false,
		},
		views: {
			Table: {
				showToolbarButtons: true,
			},
		},
	}, 'Table');

	assert.equal(resolved.showToolbarButtons, true);
	assert.equal(resolved.showGroupCounts, false);
});
