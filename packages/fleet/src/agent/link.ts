/**
 * The agent's bus link (L07 private): one stable `FleetBus` that the
 * executor, dispatcher, session server and bus-relay transport hold for the
 * agent's whole life, over whichever connection is current.
 *
 * Calls go to the current connection; with none, publishes and reads reject
 * and `status()` answers "disconnected". Subscriptions outlive a connection:
 * each remembers the last sequence its handler took and, when the next
 * connection is attached, subscribes again after it, so nothing is missed or
 * handed twice across a reconnect.
 */
import type { SignedEnvelope } from "../_generated/fleet_pb.js";
import type { FleetId, MemberId, WorkDigest } from "../ids.js";
import type {
	BusStart,
	FleetBus,
	RegistryView,
	Subscription,
} from "../ports.js";

type Bind = (bus: FleetBus, from: BusStart) => Subscription;

type Durable = {
	bind: Bind;
	from: BusStart;
	last: number | undefined;
	live: Subscription | undefined;
};

export type BusLink = Readonly<{
	bus: FleetBus;
	current(): FleetBus | undefined;
	attach(bus: FleetBus): void;
	/** Drops the current connection (closing it); subscriptions wait for the next. */
	detach(): Promise<void>;
	close(): Promise<void>;
}>;

export function createBusLink(): BusLink {
	let current: FleetBus | undefined;
	let lastRegistry: RegistryView | undefined;
	let closed = false;
	const durables = new Set<Durable>();

	const live = (): FleetBus => {
		if (current === undefined)
			throw new Error("the fleet bus is not connected");
		return current;
	};
	const registry = (): RegistryView => {
		const view = current?.registry ?? lastRegistry;
		if (view === undefined) throw new Error("the fleet bus is not connected");
		return view;
	};
	const resumeFrom = (durable: Durable): BusStart =>
		durable.last === undefined ? durable.from : { after: durable.last };

	/** `track` records how far a handler got; `bind` subscribes on a given connection from a start. */
	const durable = (
		from: BusStart,
		make: (track: (sequence: number) => void) => Bind,
	): Subscription => {
		const entry: Durable = {
			bind: () => ({ stop: async () => {} }),
			from,
			last: undefined,
			live: undefined,
		};
		entry.bind = make((sequence) => {
			if (entry.last === undefined || sequence > entry.last)
				entry.last = sequence;
		});
		durables.add(entry);
		if (current !== undefined) entry.live = entry.bind(current, from);
		return {
			async stop() {
				durables.delete(entry);
				const subscription = entry.live;
				entry.live = undefined;
				await subscription?.stop();
			},
		};
	};

	const bus: FleetBus = {
		registry: {
			member: async (id: MemberId) => registry().member(id),
			fleet: async (id: FleetId) => registry().fleet(id),
			membersOf: async (id: FleetId) => registry().membersOf(id),
			fleets: async () => registry().fleets(),
			members: async () => registry().members(),
			view: async (id: FleetId) => registry().view(id),
			trust: () => registry().trust(),
			trustEnvelope: () => registry().trustEnvelope(),
			caughtUp: async () => registry().caughtUp(),
		},
		observations: {
			publish: async (observation, observer, member) =>
				live().observations.publish(observation, observer, member),
			read: async (limit) => live().observations.read(limit),
		},
		claims: {
			claim: async (claim, fleet, digest) =>
				live().claims.claim(claim, fleet, digest),
			holder: async (fleet, digest) => live().claims.holder(fleet, digest),
			remove: async (fleet: FleetId, digest: WorkDigest) =>
				live().claims.remove(fleet, digest),
			subscribe: (fleets, from, handler) =>
				durable(
					from,
					(track) => (connection, start) =>
						connection.claims.subscribe(
							fleets,
							start,
							async (claim, fleet, digest, sequence) => {
								await handler(claim, fleet, digest, sequence);
								track(sequence);
							},
						),
				),
		},
		offers: {
			publish: async (offer, fleet) => live().offers.publish(offer, fleet),
			subscribe: (fleets, from, handler) =>
				durable(
					from,
					(track) => (connection, start) =>
						connection.offers.subscribe(
							fleets,
							start,
							async (offer, sequence) => {
								await handler(offer, sequence);
								track(sequence);
							},
						),
				),
		},
		submissions: {
			publish: async (submission, fleet) =>
				live().submissions.publish(submission, fleet),
			subscribe: (fleets, from, handler) =>
				durable(
					from,
					(track) => (connection, start) =>
						connection.submissions.subscribe(
							fleets,
							start,
							async (submission, sequence) => {
								await handler(submission, sequence);
								track(sequence);
							},
						),
				),
		},
		orders: {
			deliver: async (order, to) => live().orders.deliver(order, to),
			subscribe: (self, from, handler) =>
				durable(
					from,
					(track) => (connection, start) =>
						connection.orders.subscribe(
							self,
							start,
							async (order, sequence) => {
								await handler(order, sequence);
								track(sequence);
							},
						),
				),
			observeAll: (from, handler) =>
				durable(
					from,
					(track) => (connection, start) =>
						connection.orders.observeAll(
							start,
							async (order: SignedEnvelope, to: MemberId, sequence: number) => {
								await handler(order, to, sequence);
								track(sequence);
							},
						),
				),
		},
		events: {
			publish: async (event, from, kind) =>
				live().events.publish(event, from, kind),
			subscribe: (kinds, from, handler) =>
				durable(
					from,
					(track) => (connection, start) =>
						connection.events.subscribe(
							kinds,
							start,
							async (event, member, kind, sequence) => {
								await handler(event, member, kind, sequence);
								track(sequence);
							},
						),
				),
		},
		control: {
			send: async (control, to) => live().control.send(control, to),
			subscribe: (self, from, handler) =>
				durable(
					from,
					(track) => (connection, start) =>
						connection.control.subscribe(
							self,
							start,
							async (control, sequence) => {
								await handler(control, sequence);
								track(sequence);
							},
						),
				),
		},
		relay: {
			send: async (to, sessionId, frame) =>
				live().relay.send(to, sessionId, frame),
			subscribe: (self, handler) =>
				durable(
					"new",
					() => (connection) => connection.relay.subscribe(self, handler),
				),
		},
		status() {
			if (closed) return "closed";
			return current?.status() ?? "disconnected";
		},
		async close() {
			closed = true;
			await detach();
		},
	};

	async function detach(): Promise<void> {
		const connection = current;
		current = undefined;
		for (const entry of durables) {
			const subscription = entry.live;
			entry.live = undefined;
			await subscription?.stop().catch(() => undefined);
		}
		await connection?.close().catch(() => undefined);
	}

	return {
		bus,
		current: () => current,
		attach(connection) {
			if (closed) {
				void connection.close().catch(() => undefined);
				return;
			}
			current = connection;
			lastRegistry = connection.registry;
			for (const entry of durables)
				entry.live = entry.bind(connection, resumeFrom(entry));
		},
		detach,
		close: () => bus.close(),
	};
}
