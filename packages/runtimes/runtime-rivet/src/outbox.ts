import type { ActorLocalJournal } from "./journal.js";

export type RivetOutboxEffectInput = NonNullable<
	Parameters<ActorLocalJournal["commitCommand"]>[0]["effects"]
>[number];

export type RivetOutboxEffect = RivetOutboxEffectInput & {
	readonly streamId: string;
};

export async function dispatchRivetOutbox(
	journal: ActorLocalJournal,
	streamId: string,
	deliver: (effect: RivetOutboxEffect) => void | Promise<void>,
): Promise<number> {
	let delivered = 0;
	for (const effect of journal.pendingOutbox(streamId)) {
		await deliver({ streamId, ...effect });
		journal.markOutboxDelivered(streamId, effect.effectId, effect.digest);
		delivered += 1;
	}
	return delivered;
}
