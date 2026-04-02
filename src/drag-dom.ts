export type DragDecorationRow = {
	rowEl: HTMLElement;
	createHandle: () => HTMLElement;
};

export function clearDragDomState(root: ParentNode = document) {
	root.querySelectorAll('.cgb-row-drag-handle').forEach(el => el.remove());
	root.querySelectorAll<HTMLElement>('[data-cgb-drop-target],[data-cgb-row-draggable],[data-cgb-row-drag-cell]').forEach(el => {
		el.removeAttribute('data-cgb-drop-target');
		el.removeAttribute('data-cgb-row-draggable');
		el.removeAttribute('data-cgb-row-drag-cell');
	});
	root.querySelectorAll<HTMLElement>('.is-cgb-drop-target, .is-cgb-drop-active, .is-cgb-row-dragging').forEach(el => {
		el.classList.remove('is-cgb-drop-target', 'is-cgb-drop-active', 'is-cgb-row-dragging');
	});
}

export function syncDragDecorations(
	viewEl: HTMLElement,
	headers: HTMLElement[],
	rows: DragDecorationRow[],
	enabled: boolean,
) {
	if (!enabled) {
		clearDragDomState(viewEl);
		return;
	}

	for (const header of headers) {
		const tableEl = header.closest('.bases-table') as HTMLElement | null;
		header.setAttribute('data-cgb-drop-target', 'true');
		tableEl?.setAttribute('data-cgb-drop-target', 'true');
		tableEl?.classList.add('is-cgb-drop-target');
	}

	viewEl.querySelectorAll<HTMLElement>('.bases-tr[data-cgb-row-draggable="true"]').forEach(rowEl => {
		rowEl.removeAttribute('data-cgb-row-draggable');
		rowEl.classList.remove('is-cgb-row-dragging');
		rowEl.querySelector('.cgb-row-drag-handle')?.remove();
	});
	viewEl.querySelectorAll<HTMLElement>('[data-cgb-row-drag-cell]').forEach(cell => {
		cell.removeAttribute('data-cgb-row-drag-cell');
	});

	for (const { rowEl, createHandle } of rows) {
		rowEl.setAttribute('data-cgb-row-draggable', 'true');
		const cells = Array.from(rowEl.querySelectorAll<HTMLElement>(':scope > .bases-td'));
		cells.forEach(cell => {
			cell.removeAttribute('data-cgb-row-drag-cell');
			cell.querySelectorAll('.cgb-row-drag-handle').forEach(handleEl => handleEl.remove());
		});
		const dragCell = cells[0];
		dragCell?.setAttribute('data-cgb-row-drag-cell', 'true');
		rowEl.querySelectorAll(':scope > .cgb-row-drag-handle').forEach(handleEl => handleEl.remove());
		dragCell?.append(createHandle());
	}
}
