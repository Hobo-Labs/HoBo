/**
 * One writer for `AgentState` (L07 private). The agent owns the generation,
 * the pending refresh nonce and the trust pin; the executor owns the stream
 * positions, the seen order ids and the pending receipts (F4). Both read and
 * replace the whole state, so every write goes through one queue that reads
 * the latest state and replaces only the writer's own fields: neither can
 * undo the other's last write.
 */
import type { AgentState, KeyStore } from "../ports.js";

export type AgentFields = Pick<
	AgentState,
	"generation" | "pendingRefreshNonce" | "trust"
>;

export type StateGate = Readonly<{
	read(): Promise<AgentState>;
	/** Replaces the agent's fields with what `change` answers for the current state. */
	update(
		change: (current: AgentState) => Partial<AgentFields>,
	): Promise<AgentState>;
	/** The key store the executor gets: the same keys, its own fields only. */
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
