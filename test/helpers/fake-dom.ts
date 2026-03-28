class FakeClassList {
	private classes = new Set<string>();

	constructor(initial: string[] = []) {
		for (const value of initial) this.classes.add(value);
	}

	add(...names: string[]) {
		for (const name of names) this.classes.add(name);
	}

	remove(...names: string[]) {
		for (const name of names) this.classes.delete(name);
	}

	contains(name: string) {
		return this.classes.has(name);
	}

	values() {
		return Array.from(this.classes);
	}
}

type SelectorCheck = (el: FakeElement, root: FakeElement) => boolean;

function buildSelectorCheck(selector: string): SelectorCheck {
	if (selector === ':scope > .bases-td') {
		return (el, root) => el.parent === root && el.classList.contains('bases-td');
	}
	if (selector === ':scope > .cgb-row-drag-handle') {
		return (el, root) => el.parent === root && el.classList.contains('cgb-row-drag-handle');
	}
	if (selector.startsWith('.')) {
		const cls = selector.slice(1);
		return el => el.classList.contains(cls);
	}
	if (selector.startsWith('[') && selector.endsWith(']')) {
		const attr = selector.slice(1, -1);
		return el => el.hasAttribute(attr);
	}
	throw new Error(`Unsupported selector in fake DOM: ${selector}`);
}

export class FakeElement {
	parent: FakeElement | null = null;
	children: FakeElement[] = [];
	classList: FakeClassList;
	private attributes = new Map<string, string>();

	constructor(classes: string[] = []) {
		this.classList = new FakeClassList(classes);
	}

	append(...children: FakeElement[]) {
		for (const child of children) {
			child.parent = this;
			this.children.push(child);
		}
	}

	prepend(child: FakeElement) {
		child.parent = this;
		this.children.unshift(child);
	}

	remove() {
		if (!this.parent) return;
		this.parent.children = this.parent.children.filter(candidate => candidate !== this);
		this.parent = null;
	}

	setAttribute(name: string, value: string) {
		this.attributes.set(name, value);
	}

	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}

	hasAttribute(name: string) {
		return this.attributes.has(name);
	}

	removeAttribute(name: string) {
		this.attributes.delete(name);
	}

	closest(selector: string) {
		const matches = buildSelectorCheck(selector);
		let current: FakeElement | null = this;
		while (current) {
			if (matches(current, current)) return current;
			current = current.parent;
		}
		return null;
	}

	querySelector(selector: string) {
		return this.querySelectorAll(selector)[0] ?? null;
	}

	querySelectorAll(selector: string) {
		const selectors = selector.split(',').map(value => value.trim()).filter(Boolean).map(buildSelectorCheck);
		const results: FakeElement[] = [];
		const walk = (node: FakeElement) => {
			for (const child of node.children) {
				if (selectors.some(check => check(child, this))) results.push(child);
				walk(child);
			}
		};
		if (selector.trim() === ':scope > .bases-td') {
			for (const child of this.children) {
				if (child.classList.contains('bases-td')) results.push(child);
			}
			return results;
		}
		walk(this);
		return results;
	}
}
