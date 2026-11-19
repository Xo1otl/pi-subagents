export interface Leftover {
	readonly label: string;
	running(): boolean;
	detach(): void;
}

type Completions = Map<Promise<void>, Leftover | undefined>;

export function createPendingWork(
	onError: (id: string, error: unknown) => void,
) {
	const byOwner = new Map<string, Completions>();

	function track(
		id: string,
		completion: Promise<void>,
		leftover?: Leftover,
	): void {
		const pending: Completions = byOwner.get(id) ?? new Map();
		if (pending.has(completion)) {
			if (leftover) pending.set(completion, leftover);
			return;
		}
		pending.set(completion, leftover);
		byOwner.set(id, pending);

		const remove = () => {
			pending.delete(completion);
			if (!pending.size) byOwner.delete(id);
		};
		void completion.then(remove, (error: unknown) => {
			remove();
			onError(id, error);
		});
	}

	function running(id: string): Leftover[] {
		const work: Leftover[] = [];
		for (const handle of byOwner.get(id)?.values() ?? [])
			if (handle?.running()) work.push(handle);
		return work;
	}

	async function settled(id: string): Promise<void> {
		for (;;) {
			const pending = byOwner.get(id);
			if (!pending) return;
			await Promise.allSettled(pending.keys());
		}
	}

	async function settleAll(): Promise<void> {
		while (byOwner.size) await Promise.all(Array.from(byOwner.keys(), settled));
	}

	return {
		track,
		running,
		has: (id: string) => byOwner.has(id),
		settled,
		settleAll,
	};
}
