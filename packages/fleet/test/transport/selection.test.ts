/**
 * O31 (selection half), F14: `selectTransport` tries `p2p`, then `overlay`,
 * then `bus-relay`, whatever order it is given them in, and opens the session
 * over the first that carries it.
 */
import { describe, expect, it } from "vitest";
import type { SignedEnvelope } from "../../src/_generated/fleet_pb.js";
import { createMemoryKeyStore } from "../../src/keys/index.js";
import type {
	FleetLogEvent,
	FleetTransport,
	TransportKind,
} from "../../src/ports.js";
import { selectTransport } from "../../src/transport/index.js";
import {
	authorityKey,
	type DialMode,
	grantRecord,
	memoryNetwork,
	memoryTransport,
	signGrant,
} from "./doubles.js";

const KINDS: readonly TransportKind[] = ["p2p", "overlay", "bus-relay"];

type Logged = Readonly<{
	event: FleetLogEvent;
	fields: Readonly<Record<string, string | number | boolean>>;
}>;

/**
 * Initiator and acceptor transports of each kind on one network. Every kind
 * gives both devices the same identity, so one grant fits every transport.
 */
async function setup(
	modes: Readonly<Partial<Record<TransportKind, DialMode>>>,
	order: readonly TransportKind[] = KINDS,
): Promise<
	Readonly<{
		transports: readonly FleetTransport[];
		grant: SignedEnvelope;
		network: ReturnType<typeof memoryNetwork>;
		handled: TransportKind[];
	}>
> {
	const network = memoryNetwork();
	const initiator = await createMemoryKeyStore().open();
	const acceptor = await createMemoryKeyStore().open();
	const handled: TransportKind[] = [];
	const transports: FleetTransport[] = [];
	for (const kind of order) {
		const accepting = memoryTransport(
			network,
			kind,
			{ dial: "carry" },
			"acceptor",
		);
		await accepting.start(acceptor);
		accepting.accept(
			async () => true,
			async (stream) => {
				handled.push(kind);
				await stream.write(new Uint8Array([1]));
			},
		);
		const dialling = memoryTransport(
			network,
			kind,
			{ dial: modes[kind] ?? "carry" },
			"initiator",
		);
		await dialling.start(initiator);
		transports.push(dialling);
	}
	const grant = await signGrant(
		authorityKey().signer,
		grantRecord({
			initiator: {
				memberId: initiator.memberId,
				transportIdentity: "initiator",
			},
			acceptor: { memberId: acceptor.memberId, transportIdentity: "acceptor" },
		}),
	);
	return { transports, grant, network, handled };
}

describe("selectTransport", () => {
	it("opens over p2p when it works", async () => {
		const { transports, grant, network } = await setup({});
		const logs: Logged[] = [];
		const outcome = await selectTransport(
			transports,
			grant,
			new AbortController().signal,
			(event, fields) => logs.push({ event, fields }),
		);
		expect(outcome.ok).toBe(true);
		expect(network.dials).toEqual(["p2p"]);
		expect(network.handed).toEqual(["p2p"]);
		expect(logs).toEqual([
			{
				event: "hobo_fleet_transport_selected",
				fields: { transport: "p2p", fallbacks: 0 },
			},
		]);
	});

	it("with p2p failing, opens over overlay", async () => {
		const { transports, grant, network } = await setup({ p2p: "fail" });
		const outcome = await selectTransport(
			transports,
			grant,
			new AbortController().signal,
			() => {},
		);
		expect(outcome.ok).toBe(true);
		expect(network.dials).toEqual(["p2p", "overlay"]);
		expect(network.handed).toEqual(["overlay"]);
	});

	it("with p2p and overlay failing (one throws), opens over bus-relay", async () => {
		const { transports, grant, network, handled } = await setup({
			p2p: "fail",
			overlay: "throw",
		});
		const logs: Logged[] = [];
		const outcome = await selectTransport(
			transports,
			grant,
			new AbortController().signal,
			(event, fields) => logs.push({ event, fields }),
		);
		expect(outcome.ok).toBe(true);
		expect(network.dials).toEqual(["p2p", "overlay", "bus-relay"]);
		expect(network.handed).toEqual(["bus-relay"]);
		if (outcome.ok) {
			for await (const chunk of outcome.value.read()) {
				expect([...chunk]).toEqual([1]);
				break;
			}
			await outcome.value.close();
		}
		expect(handled).toEqual(["bus-relay"]);
		expect(logs.at(-1)?.fields).toEqual({
			transport: "bus-relay",
			fallbacks: 2,
		});
	});

	it("tries the canonical order whatever order the transports are given in", async () => {
		const { transports, grant, network } = await setup({ p2p: "fail" }, [
			"bus-relay",
			"overlay",
			"p2p",
		]);
		const outcome = await selectTransport(
			transports,
			grant,
			new AbortController().signal,
			() => {},
		);
		expect(outcome.ok).toBe(true);
		expect(network.dials).toEqual(["p2p", "overlay"]);
	});

	it("answers unavailable, naming each failure, when every transport fails", async () => {
		const { transports, grant, network } = await setup({
			p2p: "fail",
			overlay: "throw",
			"bus-relay": "fail",
		});
		const outcome = await selectTransport(
			transports,
			grant,
			new AbortController().signal,
			() => {},
		);
		expect(network.dials).toEqual(["p2p", "overlay", "bus-relay"]);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) {
			expect(outcome.error.code).toBe("unavailable");
			expect(Object.keys(outcome.error.detail ?? {})).toEqual([
				"p2p",
				"overlay",
				"bus-relay",
			]);
		}
	});

	it("answers unavailable with no transports", async () => {
		const outcome = await selectTransport(
			[],
			(await setup({})).grant,
			new AbortController().signal,
			() => {},
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("unavailable");
	});

	it("dials nothing once the signal is aborted", async () => {
		const { transports, grant, network } = await setup({});
		const controller = new AbortController();
		controller.abort();
		const outcome = await selectTransport(
			transports,
			grant,
			controller.signal,
			() => {},
		);
		expect(outcome.ok).toBe(false);
		expect(network.dials).toEqual([]);
	});

	it("answers session-denied when every transport carried the dial and the acceptor refused it", async () => {
		const network = memoryNetwork();
		const initiator = await createMemoryKeyStore().open();
		const acceptor = await createMemoryKeyStore().open();
		const transports: FleetTransport[] = [];
		for (const kind of KINDS) {
			const accepting = memoryTransport(
				network,
				kind,
				{ dial: "carry" },
				"acceptor",
			);
			await accepting.start(acceptor);
			accepting.accept(
				async () => false,
				async () => {},
			);
			const dialling = memoryTransport(
				network,
				kind,
				{ dial: "carry" },
				"initiator",
			);
			await dialling.start(initiator);
			transports.push(dialling);
		}
		const grant = await signGrant(
			authorityKey().signer,
			grantRecord({
				initiator: {
					memberId: initiator.memberId,
					transportIdentity: "initiator",
				},
				acceptor: {
					memberId: acceptor.memberId,
					transportIdentity: "acceptor",
				},
			}),
		);
		const outcome = await selectTransport(
			transports,
			grant,
			new AbortController().signal,
			() => {},
		);
		expect(outcome.ok).toBe(false);
		if (!outcome.ok) expect(outcome.error.code).toBe("session-denied");
		expect(network.handed).toEqual([]);
	});
});
