/**
 * O3, per-device isolation on the bus: for each template, every probed
 * subject outside it is refused, including another member's observation key,
 * orders and consumers, the registry and every stream administration
 * subject; a connection without TLS is refused. Also the assumptions A1
 * (`{{name()}}` expands for publish, subscribe and consumer names), A2 (the
 * callout runs for sentinel credentials) and A6 (a named `ack_policy: none`
 * pull consumer works with only the template's subjects).
 */
import { create } from "@bufbuild/protobuf";
import {
	type DeviceKeys,
	OBSERVATION_CONTEXT,
	Role,
	SignedEnvelopeSchema,
} from "@hobo/fleet";
import { connect } from "@nats-io/transport-node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STREAMS } from "../src/bus/names.js";
import type { DeviceTemplate } from "../src/bus/templates.js";
import {
	type Integration,
	refused,
	startIntegration,
	subscribeRefused,
} from "./support/integration.js";
import {
	requireBinary,
	SKIP_INTEGRATION,
	startNats,
	type TestNats,
} from "./support/nats-server.js";

const ROLES = {
	observer: Role.OBSERVER,
	executor: Role.EXECUTOR,
	dispatcher: Role.DISPATCHER,
} satisfies Readonly<Record<DeviceTemplate, Role>>;

/** Subjects no device may publish to, whatever its template; `other` is another member. */
function forbiddenPublish(self: string, other: string): readonly string[] {
	return [
		`$KV.fleet-observations.${other}.${self}`,
		`$KV.fleet-observations.${other}.${other}`,
		`$KV.fleet-registry.member.${self}`,
		"$KV.fleet-registry.trust",
		`$KV.fleet-views.fleet.builders`,
		`$KV.fleet-replay.x.y`,
		`fleet.event.${other}.receipt`,
		`fleet.control.${self}`,
		`fleet.submission.builders`,
		"fleet.journal.s1",
		"fleet.audit.entry",
		"fleet.audit.witness",
		`$JS.API.CONSUMER.CREATE.${STREAMS.orders}.${other}.fleet.order.${other}`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.orders}.${self}.fleet.order.${other}`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.control}.${self}.fleet.control.${other}`,
		`$JS.API.CONSUMER.MSG.NEXT.${STREAMS.orders}.${other}`,
		`$JS.API.CONSUMER.INFO.${STREAMS.orders}.${other}`,
		`$JS.API.CONSUMER.DELETE.${STREAMS.orders}.${other}`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.journal}.${self}.fleet.journal.>`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.audit}.${self}.fleet.audit.>`,
		`$JS.API.DIRECT.GET.${STREAMS.journal}.fleet.journal.s1`,
		`$JS.API.DIRECT.GET.${STREAMS.orders}.fleet.order.${other}`,
		...Object.values(STREAMS).flatMap((stream) => [
			`$JS.API.STREAM.CREATE.${stream}`,
			`$JS.API.STREAM.UPDATE.${stream}`,
			`$JS.API.STREAM.DELETE.${stream}`,
			`$JS.API.STREAM.PURGE.${stream}`,
			`$JS.API.STREAM.MSG.GET.${stream}`,
		]),
		"$JS.API.STREAM.CREATE.KV_fleet-registry",
		"$JS.API.STREAM.PURGE.KV_fleet-registry",
		"$JS.API.STREAM.MSG.DELETE.KV_fleet-registry",
		"$JS.API.STREAM.LIST",
		"$JS.API.CONSUMER.LIST.FLEET_ORDERS",
		"$SYS.REQ.USER.AUTH",
	];
}

/** Subjects the template withholds that a higher template grants. */
const WITHHELD = {
	observer: (self) => [
		"fleet.claim.builders.0123456789abcdef0123456789abcdef",
		"fleet.relay.someone.s1",
		`$JS.API.CONSUMER.CREATE.${STREAMS.offers}.${self}.fleet.offer.>`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.orders}.${self}.fleet.order.${self}`,
		"fleet.offer.builders",
		"fleet.order.someone",
	],
	executor: (self) => [
		"fleet.offer.builders",
		`fleet.order.${self}`,
		`$JS.API.STREAM.MSG.DELETE.${STREAMS.claims}`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.events}.${self}.fleet.event.>`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.claims}.${self}.fleet.claim.>`,
	],
	dispatcher: () => [],
} satisfies Readonly<Record<DeviceTemplate, (self: string) => string[]>>;

describe.skipIf(SKIP_INTEGRATION)("O3: per-device isolation on the bus", () => {
	let nats: TestNats | undefined;
	let integration: Integration | undefined;
	beforeAll(async () => {
		requireBinary();
		nats = await startNats();
		integration = await startIntegration(nats);
	}, 60_000);
	afterAll(async () => {
		await integration?.close();
		await nats?.stop();
	});
	const ready = (): Integration => {
		if (integration === undefined) throw new Error("nats-server did not start");
		return integration;
	};

	for (const template of ["observer", "executor", "dispatcher"] as const) {
		it(`refuses every probed subject outside the ${template} template`, async () => {
			const fleet = ready();
			const self: DeviceKeys = await fleet.device([ROLES[template]]);
			const other = await fleet.device([Role.DISPATCHER]);
			const connection = await fleet.raw(self);
			const probes = [
				...forbiddenPublish(self.memberId, other.memberId),
				...WITHHELD[template](self.memberId),
			];
			const allowed: string[] = [];
			for (const subject of probes)
				if (!(await refused(connection, subject))) allowed.push(subject);
			expect(allowed).toEqual([]);
			for (const subject of [
				`_INBOX.${other.memberId}.>`,
				`fleet.relay.${other.memberId}.>`,
				"fleet.>",
				">",
			])
				expect(await subscribeRefused(connection, subject)).toBe(true);
		}, 120_000);
	}

	it("lets a device write only its own observation key and read through its own consumer (A1, A6)", async () => {
		const fleet = ready();
		const self = await fleet.device([Role.OBSERVER]);
		const other = await fleet.device([Role.OBSERVER]);
		const bus = await fleet.connect(self);
		const envelope = create(SignedEnvelopeSchema, {
			context: OBSERVATION_CONTEXT,
			payload: new Uint8Array([1]),
		});
		await bus.observations.publish(envelope, self.memberId, self.memberId);
		await expect(
			bus.observations.publish(envelope, other.memberId, self.memberId),
		).rejects.toThrow();
		const { observations } = await bus.observations.read(1_000);
		expect(
			observations.some((entry) => entry.observerId === self.memberId),
		).toBe(true);
		expect((await bus.registry.member(self.memberId))?.memberId).toBe(
			self.memberId,
		);
		expect((await bus.registry.members()).length).toBeGreaterThanOrEqual(2);
		expect(fleet.refusals).not.toContain("request-signature");
	}, 60_000);

	it("refuses a connection without TLS", async () => {
		const fleet = ready();
		await expect(
			connect({
				servers: [fleet.nats.plainUrl],
				tls: null,
				maxReconnectAttempts: 0,
				timeout: 5_000,
			}),
		).rejects.toThrow();
	});
});
