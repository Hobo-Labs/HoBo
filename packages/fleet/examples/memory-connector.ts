/**
 * A `FleetBusConnector` over the in-memory bus, for the demo and the agent
 * tests (rule 6: the NATS connector is L08's). Each connection is a view of
 * the one memory bus: it asks for a session ticket as a real connection does,
 * and the test can take the bus down (connects fail, publishes reject, status
 * reads "disconnected") or close every live connection (status "closed").
 */
import type { SignedEnvelope } from "../src/_generated/fleet_pb.js";
import type {
	AuthorityBus,
	FleetBus,
	FleetBusConnector,
	Subscription,
} from "../src/ports.js";

export type MemoryConnector = FleetBusConnector &
	Readonly<{
		down(value: boolean): void;
		/** Closes every live connection, as a server restart would. */
		closeAll(): Promise<void>;
		connects(): number;
		tickets(): readonly SignedEnvelope[];
	}>;

export function createMemoryConnector(bus: AuthorityBus): MemoryConnector {
	let isDown = false;
	let count = 0;
	const presented: SignedEnvelope[] = [];
	const live = new Set<{ close(): Promise<void> }>();

	const view = (): FleetBus => {
		let closed = false;
		const subscriptions = new Set<Subscription>();
		const guard =
			<A extends unknown[], R>(run: (...args: A) => Promise<R>) =>
			async (...args: A): Promise<R> => {
				if (closed) throw new Error("the connection is closed");
				if (isDown) throw new Error("the bus is down");
				return run(...args);
			};
		const held = (subscription: Subscription): Subscription => {
			subscriptions.add(subscription);
			return {
				async stop() {
					subscriptions.delete(subscription);
					await subscription.stop();
				},
			};
		};
		const connection: FleetBus = {
			registry: bus.registry,
			observations: {
				publish: guard(bus.observations.publish),
				read: guard(bus.observations.read),
			},
			claims: {
				claim: guard(bus.claims.claim),
				holder: guard(bus.claims.holder),
				remove: guard(bus.claims.remove),
				subscribe: (fleets, from, handler) =>
					held(bus.claims.subscribe(fleets, from, handler)),
			},
			offers: {
				publish: guard(bus.offers.publish),
				subscribe: (fleets, from, handler) =>
					held(bus.offers.subscribe(fleets, from, handler)),
			},
			submissions: {
				publish: guard(bus.submissions.publish),
				subscribe: (fleets, from, handler) =>
					held(bus.submissions.subscribe(fleets, from, handler)),
			},
			orders: {
				deliver: guard(bus.orders.deliver),
				subscribe: (self, from, handler) =>
					held(bus.orders.subscribe(self, from, handler)),
				observeAll: (from, handler) =>
					held(bus.orders.observeAll(from, handler)),
			},
			events: {
				publish: guard(bus.events.publish),
				subscribe: (kinds, from, handler) =>
					held(bus.events.subscribe(kinds, from, handler)),
			},
			control: {
				send: guard(bus.control.send),
				subscribe: (self, from, handler) =>
					held(bus.control.subscribe(self, from, handler)),
			},
			relay: {
				send: guard(bus.relay.send),
				subscribe: (self, handler) => held(bus.relay.subscribe(self, handler)),
			},
			status: () => (closed ? "closed" : isDown ? "disconnected" : "connected"),
			async close() {
				closed = true;
				live.delete(connection);
				for (const subscription of Array.from(subscriptions))
					await subscription.stop();
				subscriptions.clear();
			},
		};
		live.add(connection);
		return connection;
	};

	return {
		async connect(input) {
			if (isDown) throw new Error("the bus is down");
			presented.push(await input.ticket());
			count += 1;
			return view();
		},
		down(value) {
			isDown = value;
		},
		async closeAll() {
			for (const connection of Array.from(live)) await connection.close();
		},
		connects: () => count,
		tickets: () => presented,
	};
}
