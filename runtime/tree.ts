export const ROOT = "root";

interface TreeNode {
	readonly id: string;
	readonly parentId: string;
}

/** Append-only: parents are registered before their children. ROOT is virtual. */
export function createIndexedTree<Node extends TreeNode>() {
	const byId = new Map<string, Node>();
	const byParent = new Map<string, Node[]>();

	function childrenOf(id: string): readonly Node[] {
		return byParent.get(id) ?? [];
	}

	function nextId(parentId: string): string {
		const index = childrenOf(parentId).length + 1;
		return parentId === ROOT ? `${index}` : `${parentId}.${index}`;
	}

	function add(node: Node): void {
		byId.set(node.id, node);
		const siblings = byParent.get(node.parentId);
		if (siblings) siblings.push(node);
		else byParent.set(node.parentId, [node]);
	}

	function* ancestors(node: Node): Generator<Node> {
		let parent = byId.get(node.parentId);
		while (parent) {
			yield parent;
			parent = byId.get(parent.parentId);
		}
	}

	function preorder(): Node[] {
		const result: Node[] = [];
		const stack = childrenOf(ROOT).toReversed();
		for (let node = stack.pop(); node; node = stack.pop()) {
			result.push(node);
			for (const child of childrenOf(node.id).toReversed()) stack.push(child);
		}
		return result;
	}

	// Unlike display order, cancellation visits nodes in creation order. Keep
	// the iterator live: a runtime listener may register more nodes mid-abort.
	function* subtree(id: string): Generator<Node> {
		if (id === ROOT) {
			yield* byId.values();
			return;
		}
		const included = new Set<string>();
		for (const node of byId.values()) {
			if (node.id !== id && !included.has(node.parentId)) continue;
			included.add(node.id);
			yield node;
		}
	}

	return {
		add,
		nextId,
		get: (id: string) => byId.get(id),
		childrenOf,
		ancestors,
		preorder,
		subtree,
		clear() {
			byId.clear();
			byParent.clear();
		},
	};
}
