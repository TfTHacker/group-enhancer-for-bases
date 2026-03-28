import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { getWritableGroupField, getWritableGroupFieldFromProperty } from '../src/group-field';

test('accepts simple frontmatter-backed note properties', () => {
	assert.deepEqual(getWritableGroupFieldFromProperty('note.priority'), {
		property: 'note.priority',
		frontmatterKey: 'priority',
	});
	assert.deepEqual(getWritableGroupField({
		config: { groupBy: { property: 'status' } },
	}), {
		property: 'status',
		frontmatterKey: 'status',
	});
});

test('rejects file-backed and nested properties', () => {
	assert.equal(getWritableGroupFieldFromProperty('file.name'), null);
	assert.equal(getWritableGroupFieldFromProperty('note.status.value'), null);
});

test('rejects special non-writable frontmatter fields', () => {
	assert.equal(getWritableGroupFieldFromProperty('note.tags'), null);
	assert.equal(getWritableGroupFieldFromProperty('cssclasses'), null);
});
