export type WritableGroupField = {
	property: string;
	frontmatterKey: string;
};

export type GroupByConfigLike = {
	config?: { groupBy?: { property?: string } };
};

export function getWritableGroupFieldFromProperty(property: string | null | undefined): WritableGroupField | null {
	if (typeof property !== 'string' || !property.length) return null;
	if (property.startsWith('file.')) return null;
	const frontmatterKey = property.startsWith('note.') ? property.slice(5) : property;
	if (!frontmatterKey || frontmatterKey.includes('.')) return null;
	const lowered = frontmatterKey.toLowerCase();
	if (['tags', 'aliases', 'cssclasses', 'position'].includes(lowered)) return null;
	return { property, frontmatterKey };
}

export function getWritableGroupField(table: GroupByConfigLike): WritableGroupField | null {
	return getWritableGroupFieldFromProperty(table.config?.groupBy?.property);
}
