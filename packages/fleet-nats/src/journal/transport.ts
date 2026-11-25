export type JournalMessage = Readonly<{
	seq: number;
	subject: string;
	data: Uint8Array;
}>;

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
	last(subject: string): Promise<JournalMessage | undefined>;
	lastSequence(): Promise<number>;
	publish(
		subject: string,
		data: Uint8Array,
		expectedLastSubjectSequence: number,
	): Promise<Readonly<{ seq: number }>>;
	messages(filter: string, fromSeq: number): AsyncIterable<JournalMessage>;
	watch(
		filter: string,
		fromSeq: number,
		onMessage: (message: JournalMessage) => void,
	): Promise<JournalWatch>;
	close(): Promise<void>;
}>;
