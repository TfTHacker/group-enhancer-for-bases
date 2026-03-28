import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { clearDragDomState, syncDragDecorations } from '../src/drag-dom';
import { FakeElement } from './helpers/fake-dom';

function createHandle() {
	const handle = new FakeElement(['cgb-row-drag-handle']);
	return handle as unknown as HTMLElement;
}

test('syncDragDecorations adds drop targets and drag handles when enabled', () => {
	const viewEl = new FakeElement(['bases-view', 'is-grouped']);
	const tableEl = new FakeElement(['bases-table']);
	const headerEl = new FakeElement(['bases-group-heading']);
	const rowEl = new FakeElement(['bases-tr']);
	const firstCell = new FakeElement(['bases-td']);
	const secondCell = new FakeElement(['bases-td']);
	viewEl.append(tableEl);
	tableEl.append(headerEl, rowEl);
	rowEl.append(firstCell, secondCell);

	syncDragDecorations(
		viewEl as unknown as HTMLElement,
		[headerEl as unknown as HTMLElement],
		[{ rowEl: rowEl as unknown as HTMLElement, createHandle }],
		true,
	);

	assert.equal(headerEl.getAttribute('data-cgb-drop-target'), 'true');
	assert.equal(tableEl.classList.contains('is-cgb-drop-target'), true);
	assert.equal(rowEl.getAttribute('data-cgb-row-draggable'), 'true');
	assert.equal(firstCell.getAttribute('data-cgb-row-drag-cell'), 'true');
	assert.equal(rowEl.querySelectorAll('.cgb-row-drag-handle').length, 1);
});

test('syncDragDecorations clears drag UI when disabled', () => {
	const viewEl = new FakeElement(['bases-view', 'is-grouped']);
	const tableEl = new FakeElement(['bases-table', 'is-cgb-drop-target', 'is-cgb-drop-active']);
	const headerEl = new FakeElement(['bases-group-heading']);
	const rowEl = new FakeElement(['bases-tr', 'is-cgb-row-dragging']);
	const cellEl = new FakeElement(['bases-td']);
	const handleEl = new FakeElement(['cgb-row-drag-handle']);
	viewEl.append(tableEl);
	tableEl.append(headerEl, rowEl);
	rowEl.append(handleEl, cellEl);
	headerEl.setAttribute('data-cgb-drop-target', 'true');
	tableEl.setAttribute('data-cgb-drop-target', 'true');
	rowEl.setAttribute('data-cgb-row-draggable', 'true');
	cellEl.setAttribute('data-cgb-row-drag-cell', 'true');

	syncDragDecorations(
		viewEl as unknown as HTMLElement,
		[headerEl as unknown as HTMLElement],
		[],
		false,
	);

	assert.equal(viewEl.querySelector('.cgb-row-drag-handle'), null);
	assert.equal(viewEl.querySelector('[data-cgb-row-draggable]'), null);
	assert.equal(viewEl.querySelector('[data-cgb-row-drag-cell]'), null);
	assert.equal(viewEl.querySelector('.is-cgb-drop-target'), null);
	assert.equal(viewEl.querySelector('.is-cgb-drop-active'), null);
});

test('clearDragDomState removes stale drag classes and attributes', () => {
	const root = new FakeElement(['bases-view']);
	const tableEl = new FakeElement(['bases-table', 'is-cgb-drop-target', 'is-cgb-drop-active']);
	const rowEl = new FakeElement(['bases-tr', 'is-cgb-row-dragging']);
	const handleEl = new FakeElement(['cgb-row-drag-handle']);
	root.append(tableEl);
	tableEl.append(rowEl);
	rowEl.append(handleEl);
	tableEl.setAttribute('data-cgb-drop-target', 'true');
	rowEl.setAttribute('data-cgb-row-draggable', 'true');

	clearDragDomState(root as unknown as ParentNode);

	assert.equal(root.querySelector('.cgb-row-drag-handle'), null);
	assert.equal(root.querySelector('.is-cgb-drop-target'), null);
	assert.equal(root.querySelector('.is-cgb-drop-active'), null);
	assert.equal(root.querySelector('.is-cgb-row-dragging'), null);
});
