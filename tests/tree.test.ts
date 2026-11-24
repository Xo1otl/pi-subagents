import { expect, test } from "bun:test";
import { createIndexedTree, ROOT } from "../runtime/tree.ts";

test("display is preorder; subtree selection retains creation order", () => {
	const tree = createIndexedTree();
	function add(parentId: string) {
		const node = { parentId, id: tree.nextId(parentId) };
		tree.add(node);
		return node;
	}
	const a = add(ROOT);
	const b = add(ROOT);
	const aa = add(a.id);
	const ab = add(a.id);
	const ba = add(b.id);
	const aaa = add(aa.id);

	expect(tree.childrenOf(a.id)).toEqual([aa, ab]);
	expect([...tree.ancestors(aaa)]).toEqual([aa, a]);
	expect(tree.preorder()).toEqual([a, aa, aaa, ab, b, ba]);
	expect([...tree.subtree(ROOT)]).toEqual([a, b, aa, ab, ba, aaa]);
	expect([...tree.subtree(a.id)]).toEqual([a, aa, ab, aaa]);
	expect([...tree.subtree("missing")]).toEqual([]);

	tree.clear();
	expect(tree.get(a.id)).toBeUndefined();
	expect(tree.preorder()).toEqual([]);
	expect(tree.nextId(ROOT)).toBe("1");
});
