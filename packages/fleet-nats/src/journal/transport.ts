/**
 * The narrow view of JetStream the journal store needs (L36): one stream,
 * read by subject filter and by stream sequence, written with the
 * expected-last-subject-sequence compare-and-set. `nats.ts` implements it on
 * `@nats-io/jetstream`; the unit tests implement it in memory (a fake
 * JetStream context, no module mocking).
 */

/** One stored message of the journal stream. */
export type JournalMessage = Readonly<{
	/** The JetStream stream sequence of the message. */
	seq: number;
	subject: string;
	data: Uint8Array;
}>;

/** Thrown by `publish` when the subject's last sequence is not the expected one (JetStream API code 10071). */
export class JournalWrongLastSequence extends Error {
	constructor(subject: string, expected: number) {
		super(
			`journal: ${subject} has moved past expected last sequence ${expected}`,
		);
		this.name = "JournalWrongLastSequence";
	}
}

export type JournalWatch = Readonly<{ stop(): Promise<void> }>;

export type JournalTransport = Readonly<{
	/** The last message on `subject`, or undefined when the subject has none. */
	last(subject: string): Promise<JournalMessage | undefined>;
	/** The stream's last sequence (0 when empty). */
	lastSequence(): Promise<number>;
	/**
	 * Publishes `data` on `subject` only if the subject's last stored message has stream sequence
	 * `expectedLastSubjectSequence` (0: the subject has none). Rejects with `JournalWrongLastSequence` otherwise.
	 */
	publish(
		subject: string,
		data: Uint8Array,
		expectedLastSubjectSequence: number,
	): Promise<Readonly<{ seq: number }>>;
	/** The messages stored now whose subject matches `filter`, from stream sequence `fromSeq` on, in stream order; ends at the current end. */
	messages(filter: string, fromSeq: number): AsyncIterable<JournalMessage>;
	/** Delivers every message matching `filter` from stream sequence `fromSeq` on, as it is stored, in stream order. */
	watch(
		filter: string,
		fromSeq: number,
		onMessage: (message: JournalMessage) => void,
	): Promise<JournalWatch>;
	close(): Promise<void>;
}>;
