// A catch-up read store over the journal: folds the events of some types in
// global position order and remembers its last position, so each query reads
// only what was appended since. Rebuilt from position zero on construction.
import type {
	DurableEventStore,
	EventEnvelope,
	EventPosition,
	ReadAllOptions,
} from "@hobo/core";

export type Fold = (event: EventEnvelope, position: EventPosition) => void;

export class CatchUpProjection {
	private readonly cursors = new Map<string, EventPosition | undefined>();
	private running: Promise<void> | undefined;

	constructor(
		private readonly store: DurableEventStore,
		private readonly tenant: string,
		private readonly folds: Readonly<Record<string, Fold>>,
	) {}

	/** Fold everything appended since the last call. Concurrent callers share one pass. */
	async catchUp(): Promise<void> {
		this.running ??= this.pass().finally(() => {
			this.running = undefined;
		});
		await this.running;
	}

	private async pass(): Promise<void> {
		const pending: {
			position: EventPosition;
			event: EventEnvelope;
			type: string;
		}[] = [];
		for (const type of Object.keys(this.folds).sort()) {
			const after = this.cursors.get(type);
			let last = after;
			const options: ReadAllOptions =
				after === undefined
					? { filter: { type }, tenant: this.tenant }
					: { filter: { type }, tenant: this.tenant, after };
			for await (const positioned of this.store.readAll(options)) {
				pending.push({
					position: positioned.position,
					event: positioned.event,
					type,
				});
				last = positioned.position;
			}
			this.cursors.set(type, last);
		}
		pending.sort((a, b) =>
			a.position < b.position ? -1 : a.position > b.position ? 1 : 0,
		);
		for (const item of pending)
			this.folds[item.type]?.(item.event, item.position);
	}
}
