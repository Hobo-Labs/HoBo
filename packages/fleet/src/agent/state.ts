import type { AgentState, KeyStore } from "../ports.js";

export type AgentFields = Pick<
	AgentState,
	"generation" | "pendingRefreshNonce" | "trust"
>;

export type StateGate = Readonly<{
	read(): Promise<AgentState>;
	update(
		change: (current: AgentState) => Partial<AgentFields>,
	): Promise<AgentState>;
	executorStore: KeyStore;
}>;

export function createStateGate(store: KeyStore): StateGate {
	let queue: Promise<void> = Promise.resolve();
	const serial = <T>(run: () => Promise<T>): Promise<T> => {
		const next = queue.then(run);
		queue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	return {
		read: () => serial(() => store.readState()),
		update: (change) =>
			serial(async () => {
				const current = await store.readState();
				const next: AgentState = { ...current, ...change(current) };
				await store.writeState(next);
				return next;
			}),
		executorStore: {
			open: () => store.open(),
			readState: () => serial(() => store.readState()),
			writeState: (next) =>
				serial(async () => {
					const current = await store.readState();
					await store.writeState({
						...current,
						lastSequence: next.lastSequence,
						seenOrderIds: next.seenOrderIds,
						pendingReceipts: next.pendingReceipts,
					});
				}),
			rotateOperational: () => store.rotateOperational(),
			destroy: () => store.destroy(),
		},
	};
}
