/**
 * A small world for the loop tests: the memory bus with records seeded, test
 * work sources and runners, a fake capacity source and egress proxy, and the
 * fake sandbox driver from `@hobo/fleet/testing`. Used under vitest's fake
 * timers with `now: () => Date.now()`.
 */
import { create } from "@bufbuild/protobuf";
import {
	CapacitySchema,
	type FleetRecord,
	Health,
	ReceiptStatus,
	type SandboxTier,
	type ViolationReport,
	WorkNeedsSchema,
	type WorkOffer,
	WorkOrigin,
} from "../../src/_generated/fleet_pb.js";
import type {
	AuthorityBus,
	CapacitySource,
	EgressProxyFactory,
	FleetLog,
	FleetLogEvent,
	UpstreamWork,
	WorkRunner,
	WorkSource,
} from "../../src/ports.js";
import { createFakeSandboxDriver } from "../../src/testing/plumbing/index.js";

export type LogLine = Readonly<{
	event: FleetLogEvent;
	fields: Readonly<Record<string, string | number | boolean>>;
}>;

export function recorder() {
	const lines: LogLine[] = [];
	const log: FleetLog = (event, fields) => {
		lines.push({ event, fields });
	};
	return { lines, log };
}

export function upstream(
	workKey: string,
	queuedAtMs: number,
	init: Partial<UpstreamWork> = {},
): UpstreamWork {
	return {
		workKey,
		label: "hobo",
		needs: create(WorkNeedsSchema, { labels: [] }),
		author: "github:2",
		origin: WorkOrigin.INTERNAL,
		repository: "acme/app",
		ref: "refs/heads/main",
		workflowDigest: "",
		queuedAtMs,
		...init,
	};
}

/** A work source whose queue the test fills; it prepares a fixed secret. */
export function testSource(kind = "github-actions-job") {
	const queue: UpstreamWork[] = [];
	const prepared: string[] = [];
	let wanted = true;
	const source: WorkSource & {
		queue: UpstreamWork[];
		prepared: string[];
		setWanted(value: boolean): void;
	} = {
		kind,
		queue,
		prepared,
		setWanted(value) {
			wanted = value;
		},
		async poll(_fleet: FleetRecord) {
			return [...queue];
		},
		async prepare(offer: WorkOffer) {
			prepared.push(offer.workKey);
			const index = queue.findIndex((work) => work.workKey === offer.workKey);
			if (index >= 0) queue.splice(index, 1);
			return {
				ok: true,
				value: {
					parameters: { image: "runner:latest" },
					secret: new TextEncoder().encode(`secret-${offer.workKey}`),
					egressAllow: ["api.github.com"],
				},
			};
		},
		async stillWanted() {
			return wanted;
		},
	};
	return source;
}

/** A runner that records what it ran and succeeds unless told otherwise. */
export function testRunner(
	kind = "github-actions-job",
	body?: WorkRunner["run"],
) {
	const ran: { workKey: string; secret: string; tier: SandboxTier }[] = [];
	const runner: WorkRunner & { ran: typeof ran } = {
		kind,
		ran,
		async run(input) {
			ran.push({
				workKey: input.order.offer?.workKey ?? "",
				secret: new TextDecoder().decode(input.secret),
				tier: input.sandbox.tier,
			});
			if (body !== undefined) return body(input);
			input.onLog(new TextEncoder().encode("hello"));
			return {
				status: ReceiptStatus.SUCCEEDED,
				reason: "",
				outputDigest: "sha256:00",
				observedWorkKey: input.order.offer?.workKey ?? "",
			};
		},
	};
	return runner;
}

export function capacity(slots: number): CapacitySource {
	return {
		async read() {
			return {
				capacity: create(CapacitySchema, {
					freeSlots: slots,
					totalSlots: slots,
				}),
				health: Health.REACHABLE,
				labels: [],
			};
		},
	};
}

export function egress(): EgressProxyFactory & { opened: string[][] } {
	const opened: string[][] = [];
	return {
		opened,
		async open(allow) {
			opened.push([...allow]);
			return { url: "http://proxy.invalid:3128", async close() {} };
		},
	};
}

export function reports() {
	const sent: ViolationReport[] = [];
	const report = async (sentReport: ViolationReport): Promise<void> => {
		sent.push(sentReport);
	};
	return { sent, report };
}

export function fakeDriver(tier: SandboxTier) {
	return createFakeSandboxDriver(tier);
}

/** A bus whose status the test switches; while "down" every publish rejects. */
export function switchableBus(
	bus: AuthorityBus,
): AuthorityBus & { down(value: boolean): void } {
	let isDown = false;
	const guard =
		<A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
		async (...args: A): Promise<R> => {
			if (isDown) throw new Error("the bus is down");
			return fn(...args);
		};
	return {
		...bus,
		down(value: boolean) {
			isDown = value;
		},
		status: () => (isDown ? "disconnected" : bus.status()),
		claims: {
			...bus.claims,
			claim: guard(bus.claims.claim),
			holder: guard(bus.claims.holder),
		},
		events: { ...bus.events, publish: guard(bus.events.publish) },
		offers: { ...bus.offers, publish: guard(bus.offers.publish) },
	};
}
