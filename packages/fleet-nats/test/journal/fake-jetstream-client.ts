/**
 * A fake of the `@nats-io/jetstream` client surface `JournalJetStream` names,
 * on a `FakeJournalStream`. Its API errors are the real `JetStreamApiError`
 * with the server's codes: 10059 stream not found, 10037 no message found,
 * 10071 wrong last sequence.
 */
import {
	JetStreamApiError,
	type OrderedConsumerOptions,
} from "@nats-io/jetstream";
import type { JournalJetStream } from "../../src/journal/nats.js";
import type { JournalMessage } from "../../src/journal/transport.js";
import { type FakeJournalStream, subjectMatches } from "./fake-jetstream.js";

export type AddedStream = Readonly<{
	name: string;
	subjects: readonly string[];
	maxAge: number;
	replicas: number;
	denyDelete: boolean;
	denyPurge: boolean;
}>;

export type FakeJetStreamState = {
	created: boolean;
	subjects: readonly string[];
	readonly added: AddedStream[];
	readonly ackPolicies: string[];
	readonly deletedConsumers: string[];
	consumers: number;
	/** Thrown once by `streams.info` instead of answering. */
	infoFailure?: Error | undefined;
	/** Thrown once by `getMessage` instead of answering. */
	getFailure?: Error | undefined;
	/** Thrown once by `publish` instead of answering. */
	publishFailure?: Error | undefined;
	/** `getMessage` answers null, not the "no message" API error, for a subject with none. */
	nullForMissing: boolean;
	/** `fetch` answers one empty batch. */
	emptyFetch: boolean;
};

export function createFakeJetStreamState(
	overrides: Partial<FakeJetStreamState> = {},
): FakeJetStreamState {
	return {
		created: false,
		subjects: [],
		added: [],
		ackPolicies: [],
		deletedConsumers: [],
		consumers: 0,
		nullForMissing: false,
		emptyFetch: false,
		...overrides,
	};
}

export const apiError = (errCode: number, code: number, description: string) =>
	new JetStreamApiError({ err_code: errCode, code, description });

function isName(
	value: string | Partial<OrderedConsumerOptions>,
): value is string {
	return Object.prototype.toString.call(value) === "[object String]";
}

function copy(message: JournalMessage): JournalMessage {
	return {
		seq: message.seq,
		subject: message.subject,
		data: message.data.slice(),
	};
}

function takeOnce(
	state: FakeJetStreamState,
	key: "infoFailure" | "getFailure" | "publishFailure",
) {
	const failure = state[key];
	state[key] = undefined;
	if (failure !== undefined) throw failure;
}

export function createFakeJetStream(
	stream: FakeJournalStream,
	state: FakeJetStreamState,
): JournalJetStream {
	const matching = (filter: string, fromSeq: number) =>
		stream.messages.filter(
			(message) =>
				message.seq >= fromSeq && subjectMatches(filter, message.subject),
		);
	const pulls = new Map<string, { filter: string; next: number }>();
	const ensureStream = () => {
		if (!state.created) throw apiError(10059, 404, "stream not found");
	};
	return {
		streams: {
			async info() {
				takeOnce(state, "infoFailure");
				ensureStream();
				return {
					config: { subjects: state.subjects },
					state: { last_seq: stream.messages.at(-1)?.seq ?? 0 },
				};
			},
			async add(config) {
				state.created = true;
				state.subjects = config.subjects ?? [];
				state.added.push({
					name: config.name,
					subjects: config.subjects ?? [],
					maxAge: config.max_age ?? -1,
					replicas: config.num_replicas ?? -1,
					denyDelete: config.deny_delete ?? false,
					denyPurge: config.deny_purge ?? false,
				});
				return {};
			},
			async getMessage(_name, query) {
				takeOnce(state, "getFailure");
				ensureStream();
				const last = matching(query.last_by_subj, 1).at(-1);
				if (last !== undefined) return copy(last);
				if (state.nullForMissing) return null;
				throw apiError(10037, 404, "no message found");
			},
		},
		consumers: {
			async add(_stream, config) {
				ensureStream();
				state.consumers += 1;
				state.ackPolicies.push(String(config.ack_policy));
				const name = `fake-${state.consumers}`;
				const filter = config.filter_subject ?? ">";
				const from = config.opt_start_seq ?? 1;
				pulls.set(name, { filter, next: from });
				return { name, num_pending: matching(filter, from).length };
			},
			async delete(_stream, name) {
				state.deletedConsumers.push(name);
				return pulls.delete(name);
			},
		},
		async publish(subject, data, options) {
			takeOnce(state, "publishFailure");
			ensureStream();
			const expected = options.expect?.lastSubjectSequence ?? 0;
			const last = matching(subject, 1).at(-1)?.seq ?? 0;
			if (last !== expected) {
				stream.publishes.push({ subject, expected, accepted: false });
				throw apiError(10071, 400, `wrong last sequence: ${last}`);
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
		async consumer(_stream, nameOrOrdered) {
			return {
				async fetch(options) {
					if (state.emptyFetch) {
						state.emptyFetch = false;
						return (async function* () {})();
					}
					const pull = isName(nameOrOrdered)
						? pulls.get(nameOrOrdered)
						: undefined;
					if (pull === undefined) throw new Error("no such pull consumer");
					const batch = matching(pull.filter, pull.next).slice(
						0,
						options.max_messages ?? 1,
					);
					return (async function* () {
						for (const message of batch) {
							pull.next = message.seq + 1;
							yield {
								...copy(message),
								info: { pending: matching(pull.filter, pull.next).length },
							};
						}
					})();
				},
				async consume() {
					const ordered = isName(nameOrOrdered) ? {} : nameOrOrdered;
					const filters = ordered.filter_subjects ?? ">";
					const filter = Array.isArray(filters) ? (filters[0] ?? ">") : filters;
					const from = ordered.opt_start_seq ?? 1;
					const queue: JournalMessage[] = matching(filter, from).map(copy);
					let wake: (() => void) | undefined;
					let closed = false;
					const watcher = (message: JournalMessage) => {
						if (message.seq < from || !subjectMatches(filter, message.subject))
							return;
						queue.push(message);
						wake?.();
					};
					stream.watchers.add(watcher);
					const iterate = async function* () {
						for (;;) {
							const next = queue.shift();
							if (next !== undefined) {
								yield { ...next, info: { pending: queue.length } };
								continue;
							}
							if (closed) return;
							await new Promise<void>((resolve) => {
								wake = resolve;
							});
							wake = undefined;
						}
					};
					return Object.assign(iterate(), {
						async close() {
							closed = true;
							stream.watchers.delete(watcher);
							wake?.();
						},
					});
				},
			};
		},
		async close() {},
	};
}
