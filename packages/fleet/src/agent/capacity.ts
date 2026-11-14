/**
 * What the agent knows about its own capacity beyond `deps.capacity` (L43,
 * amendment 4, D60): how many of its own orders are running, and the refusal
 * and health it publishes.
 *
 * - The executor opens one egress proxy per order before it creates the
 *   sandbox and closes it after the sandbox is destroyed, whatever the
 *   outcome, so counting open proxies counts the orders it is running. The
 *   executor's own count (claims held for an order, plus running orders) is
 *   private to L04; a claim still waiting for its order is not counted here.
 * - The executor fits work against `deps.capacity`; the agent hands it a
 *   source whose health is `PRESSURED` while the host refuses for storage or
 *   pressure, so it claims nothing the observation says it refuses.
 */
import { create } from "@bufbuild/protobuf";
import {
	type Capacity,
	CapacitySchema,
	type Health,
	type Refusal,
} from "../_generated/fleet_pb.js";
import {
	type CapacityReading,
	deriveRefusal,
	hostSignalsOf,
	publishedHealth,
} from "../observation/refusal.js";
import type { CapacitySource, EgressProxyFactory } from "../ports.js";

/** Counts the orders running through `egress`: one open proxy each. */
export function countOwnWork(egress: EgressProxyFactory): Readonly<{
	egress: EgressProxyFactory;
	running(): number;
}> {
	let open = 0;
	return Object.freeze({
		egress: Object.freeze({
			async open(allow: readonly string[]) {
				const proxy = await egress.open(allow);
				open += 1;
				let closed = false;
				return Object.freeze({
					url: proxy.url,
					async close() {
						if (!closed) {
							closed = true;
							open -= 1;
						}
						await proxy.close();
					},
				});
			},
		} satisfies EgressProxyFactory),
		running: () => open,
	});
}

/** The source the executor reads: the host's refusal for storage or pressure shows as `PRESSURED`. */
export function refusingCapacity(source: CapacitySource): CapacitySource {
	return Object.freeze({
		async read() {
			const reading = await source.read();
			const refusal = deriveRefusal({
				draining: false,
				health: reading.health,
				capacity: reading.capacity,
				host: hostSignalsOf(reading),
			});
			return Object.freeze({
				capacity: reading.capacity,
				health: publishedHealth(refusal, reading.health),
				labels: reading.labels,
			});
		},
	} satisfies CapacitySource);
}

export type SelfCapacity = Readonly<{
	capacity: Capacity | undefined;
	health: Health;
	refusal: Refusal;
}>;

/** The capacity, health and refusal of the agent's self-observation. */
export function selfCapacity(
	reading: CapacityReading | undefined,
	running: number,
	draining: boolean,
): SelfCapacity {
	const capacity =
		reading === undefined
			? undefined
			: create(CapacitySchema, {
					...reading.capacity,
					freeSlots: Math.max(0, reading.capacity.freeSlots - running),
				});
	const refusal = deriveRefusal({
		draining,
		health: reading?.health,
		capacity,
		host: hostSignalsOf(reading),
	});
	return Object.freeze({
		capacity,
		health: publishedHealth(refusal, reading?.health),
		refusal,
	});
}
