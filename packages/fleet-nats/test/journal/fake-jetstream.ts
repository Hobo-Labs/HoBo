/**
 * A fake JetStream context for the journal store's unit tests: one in-memory
 * stream that keeps every message with its stream sequence, honours the
 * expected-last-subject-sequence compare-and-set, matches subjects the way
 * NATS does (`*` one token, `>` the rest), and delivers to watchers in stream
 * order. Several transports can share one stream, as several authority
 * replicas share `FLEET_JOURNAL`.
 */
import {
	type JournalMessage,
	type JournalTransport,
	type JournalWatch,
	JournalWrongLastSequence,
} from "../../src/journal/transport.js";

export type FakeJournalStream = Readonly<{
	messages: JournalMessage[];
	watchers: Set<(message: JournalMessage) => void>;
	/** Counts every publish attempt with the expected sequence it carried. */
	publishes: { subject: string; expected: number; accepted: boolean }[];
}>;

export function createFakeJournalStream(): FakeJournalStream {
	return { messages: [], watchers: new Set(), publishes: [] };
}

export function subjectMatches(filter: string, subject: string): boolean {
	const want = filter.split(".");
	const have = subject.split(".");
	for (const [index, token] of want.entries()) {
		if (token === ">") return have.length > index;
		if (index >= have.length) return false;
		if (token !== "*" && token !== have[index]) return false;
	}
	return want.length === have.length;
}

export type FakeTransportOptions = Readonly<{
	/** Runs just before a publish is checked, to let a test slip another writer in. */
	beforePublish?: () => Promise<void>;
}>;

export function createFakeJournalTransport(
	stream: FakeJournalStream,
	options: FakeTransportOptions = {},
): JournalTransport & Readonly<{ closed(): boolean }> {
	let closed = false;
	const open = () => {
		if (closed) throw new Error("fake journal transport is closed");
	};
	return {
		closed: () => closed,
		async last(subject) {
			open();
			for (let index = stream.messages.length - 1; index >= 0; index -= 1) {
				const message = stream.messages[index];
				if (message !== undefined && message.subject === subject)
					return copy(message);
			}
			return undefined;
		},
		async lastSequence() {
			open();
			return stream.messages.at(-1)?.seq ?? 0;
		},
		async publish(subject, data, expected) {
			open();
			await options.beforePublish?.();
			let lastOfSubject = 0;
			for (const message of stream.messages)
				if (message.subject === subject) lastOfSubject = message.seq;
			if (lastOfSubject !== expected) {
				stream.publishes.push({ subject, expected, accepted: false });
				throw new JournalWrongLastSequence(subject, expected);
			}
			stream.publishes.push({ subject, expected, accepted: true });
			const message: JournalMessage = {
				seq: (stream.messages.at(-1)?.seq ?? 0) + 1,
				subject,
				data: data.slice(),
			};
			stream.messages.push(message);
			for (const watcher of stream.watchers) watcher(copy(message));
			return { seq: message.seq };
		},
		async *messages(filter, fromSeq) {
			open();
			const end = stream.messages.length;
			for (const message of stream.messages.slice(0, end)) {
				if (message.seq < fromSeq) continue;
				if (subjectMatches(filter, message.subject)) yield copy(message);
			}
		},
		async watch(filter, fromSeq, onMessage): Promise<JournalWatch> {
			open();
			for (const message of stream.messages)
				if (message.seq >= fromSeq && subjectMatches(filter, message.subject))
					onMessage(copy(message));
			const watcher = (message: JournalMessage) => {
				if (message.seq >= fromSeq && subjectMatches(filter, message.subject))
					onMessage(message);
			};
			stream.watchers.add(watcher);
			return {
				async stop() {
					stream.watchers.delete(watcher);
				},
			};
		},
		async close() {
			closed = true;
		},
	};
}

function copy(message: JournalMessage): JournalMessage {
	return {
		seq: message.seq,
		subject: message.subject,
		data: message.data.slice(),
	};
}
