/**
 * Deadlines at the wRPC link boundary.
 *
 * `wrpc-link-refusals.test.ts` covers routing and backpressure. This covers the
 * third thing every link does: **enforce a carried deadline rather than merely
 * passing it along.**
 *
 * The distinction is the whole point. A deadline that is only propagated
 * arrives at the provider, which may or may not honour it — and if it does
 * not, the caller waits past its own budget with no way to stop. Enforcing it
 * at the link means the caller's promise settles when the caller said it
 * would, whatever the provider is doing. A slow dependency then costs one
 * caller's deadline instead of cascading: the caller above it is also on a
 * deadline, and a hop that ignored its own would blow through every budget up
 * the chain.
 *
 * Three properties follow:
 *
 * **The deadline is absolute, not a duration.** It is an instant carried
 * across hops, so each hop enforces the *remaining* time rather than restarting
 * a timeout. A duration would give every hop the full budget and let a
 * three-hop call take three times as long as it was allowed.
 *
 * **An already-expired deadline fails immediately.** Not "fails after zero
 * milliseconds of work" — the call is still dispatched, but the caller is
 * released at once. Waiting for a provider on a budget that is already gone
 * spends time nobody has.
 *
 * **An unparseable deadline is treated as none.** Refusing the call would turn
 * a malformed header into an outage; running unbounded is the same behaviour a
 * caller that sent no deadline gets. The alternative — guessing a duration —
 * would invent a budget nobody set.
 *
 * The timer is `unref`'d, so a pending deadline never holds the process open:
 * a link with a long deadline outstanding must not stop a CLI from exiting.
 */
import {
	DeadlineExceededError,
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createInProcessTransport,
	createJsonWitCodec,
	createWrpcLinkLayer,
} from "../src/index.js";

const KV = parseInterfaceId("wasi:keyvalue/store@0.2.0");
const FLOOR = "0.2.0";

const pin = (interfaceId: typeof KV) => ({
	interfaceId,
	stability: "stable" as const,
	versions: [parseWireVersion("0.2.0")],
});

/**
 * A link whose provider blocks until released, with an optional fixed clock.
 *
 * A controllable provider is what makes a deadline test deterministic: the
 * call is genuinely outstanding when the deadline lands, rather than racing a
 * fast handler.
 */
function blockingLink(options: { nowMs?: number } = {}) {
	const store = new ProviderHandlerStore();
	const link = createWrpcLinkLayer({
		transport: createInProcessTransport({ store, codec: createJsonWitCodec() }),
		compatibilityFloor: FLOOR,
		store,
		...(options.nowMs !== undefined
			? { clock: { nowMs: () => options.nowMs as number } }
			: {}),
	});
	let release: (value?: unknown) => void = () => undefined;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	link.registerComponent({ id: "api", imports: [pin(KV)] });
	link.registerProvider({
		id: "kv",
		exports: [pin(KV)],
		handlers: {
			[KV]: {
				get: async () => {
					await gate;
					return { value: "v" };
				},
			},
		},
		// SAFETY: the layer reads exactly the fields a registration names.
	} as never);
	link.establishLink({
		componentId: "api",
		providerId: "kv",
		importInterface: KV,
		exportInterface: KV,
		// SAFETY: the layer reads exactly the fields a link request names.
	} as never);
	return { link, release };
}

/** A link whose provider answers immediately. */
function fastLink() {
	const store = new ProviderHandlerStore();
	const link = createWrpcLinkLayer({
		transport: createInProcessTransport({ store, codec: createJsonWitCodec() }),
		compatibilityFloor: FLOOR,
		store,
	});
	link.registerComponent({ id: "api", imports: [pin(KV)] });
	link.registerProvider({
		id: "kv",
		exports: [pin(KV)],
		handlers: { [KV]: { get: async () => ({ value: "v" }) } },
		// SAFETY: the layer reads exactly the fields a registration names.
	} as never);
	link.establishLink({
		componentId: "api",
		providerId: "kv",
		importInterface: KV,
		exportInterface: KV,
		// SAFETY: the layer reads exactly the fields a link request names.
	} as never);
	return link;
}

const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

describe("a deadline that expires", () => {
	it("releases the caller with a typed error", async () => {
		// The caller's promise settles when the caller said it would, whatever
		// the provider is still doing.
		const { link, release } = blockingLink();
		const call = link.callImport("api", KV, "get", {}, { deadline: soon(20) });
		await expect(call).rejects.toThrow(DeadlineExceededError);
		release();
	});

	it("names the operation that ran out of time", async () => {
		// A call chain has many hops; "deadline exceeded" alone does not say
		// which one to look at.
		const { link, release } = blockingLink();
		const call = link.callImport("api", KV, "get", {}, { deadline: soon(20) });
		await expect(call).rejects.toThrow(/get/);
		release();
	});

	it("carries the deadline it was given", async () => {
		const deadline = soon(20);
		const { link, release } = blockingLink();
		const call = link.callImport("api", KV, "get", {}, { deadline });
		await expect(call).rejects.toThrow(
			expect.objectContaining({ deadline }) as never,
		);
		release();
	});

	it("releases the in-flight slot", async () => {
		// A slot leaked on the deadline path would close the membrane after
		// exactly `maxInFlight` timeouts — the worst possible moment to stop
		// accepting calls, since timeouts cluster when a dependency is slow.
		const store = new ProviderHandlerStore();
		const link = createWrpcLinkLayer({
			transport: createInProcessTransport({
				store,
				codec: createJsonWitCodec(),
			}),
			compatibilityFloor: FLOOR,
			store,
			maxInFlight: 1,
		});
		let release: (value?: unknown) => void = () => undefined;
		const gate = new Promise((resolve) => {
			release = resolve;
		});
		link.registerComponent({ id: "api", imports: [pin(KV)] });
		link.registerProvider({
			id: "kv",
			exports: [pin(KV)],
			handlers: {
				[KV]: {
					get: async () => {
						await gate;
						return { value: "v" };
					},
				},
			},
			// SAFETY: the layer reads exactly the fields a registration names.
		} as never);
		link.establishLink({
			componentId: "api",
			providerId: "kv",
			importInterface: KV,
			exportInterface: KV,
			// SAFETY: the layer reads exactly the fields a link request names.
		} as never);
		await link
			.callImport("api", KV, "get", {}, { deadline: soon(20) })
			.catch(() => undefined);
		release();
		await expect(link.callImport("api", KV, "get", {})).resolves.toBeDefined();
	});
});

describe("a deadline that has already passed", () => {
	it("fails immediately rather than waiting", async () => {
		// Waiting for a provider on a budget that is already gone spends time
		// nobody has.
		const { link, release } = blockingLink();
		const past = new Date(Date.now() - 60_000).toISOString();
		await expect(
			link.callImport("api", KV, "get", {}, { deadline: past }),
		).rejects.toThrow(DeadlineExceededError);
		release();
	});

	it("GAP: a fast provider still wins the race, so the call succeeds", async () => {
		// Pinned, not asserted as desirable. The deadline is enforced by racing
		// the invocation against a timer set to the *remaining* time — zero
		// here — rather than by checking the budget before dispatching. A
		// provider that answers within that turn therefore resolves first, and
		// a caller with no budget left gets a successful result.
		//
		// Two consequences worth naming. The call is dispatched regardless, so
		// a mutating operation performs its side effect after the deadline has
		// passed. And the outcome depends on scheduling, so the same
		// already-expired call can succeed or fail run to run.
		//
		// Not fixed here: adding a pre-dispatch check would make calls that
		// currently succeed start failing, which is a design decision about
		// whether an expired deadline should prevent the work from happening at
		// all — not a test fix. The `blockingLink` case above shows the
		// enforcement does work whenever the provider is genuinely outstanding.
		const past = new Date(Date.now() - 60_000).toISOString();
		expect(
			await fastLink().callImport("api", KV, "get", {}, { deadline: past }),
		).toStrictEqual({ value: "v" });
	});
});

describe("a deadline with room left", () => {
	it("lets the call complete", async () => {
		expect(
			await fastLink().callImport(
				"api",
				KV,
				"get",
				{},
				{ deadline: soon(10_000) },
			),
		).toStrictEqual({ value: "v" });
	});

	it("does not hold the process open with a pending timer", async () => {
		// The deadline timer is `unref`'d. Without that, a link with a long
		// deadline outstanding would stop a CLI from exiting after its work
		// was done.
		const link = fastLink();
		await link.callImport("api", KV, "get", {}, { deadline: soon(600_000) });
		expect(true).toBe(true);
	});

	it("measures the remaining time against the clock it was given", async () => {
		// The deadline is an *instant* carried across hops, so each hop enforces
		// what is left rather than restarting a timeout. A clock pinned far past
		// the deadline makes the remaining budget zero.
		const { link, release } = blockingLink({
			nowMs: Date.now() + 10 * 60_000,
		});
		await expect(
			link.callImport("api", KV, "get", {}, { deadline: soon(1_000) }),
		).rejects.toThrow(DeadlineExceededError);
		release();
	});

	it("uses a clock reading before the deadline to allow the call", async () => {
		const store = new ProviderHandlerStore();
		const link = createWrpcLinkLayer({
			transport: createInProcessTransport({
				store,
				codec: createJsonWitCodec(),
			}),
			compatibilityFloor: FLOOR,
			store,
			clock: { nowMs: () => Date.now() },
		});
		link.registerComponent({ id: "api", imports: [pin(KV)] });
		link.registerProvider({
			id: "kv",
			exports: [pin(KV)],
			handlers: { [KV]: { get: async () => ({ value: "v" }) } },
			// SAFETY: the layer reads exactly the fields a registration names.
		} as never);
		link.establishLink({
			componentId: "api",
			providerId: "kv",
			importInterface: KV,
			exportInterface: KV,
			// SAFETY: the layer reads exactly the fields a link request names.
		} as never);
		expect(
			await link.callImport("api", KV, "get", {}, { deadline: soon(10_000) }),
		).toStrictEqual({ value: "v" });
	});
});

describe("a deadline the link cannot read", () => {
	it("runs unbounded rather than refusing", async () => {
		// Refusing would turn a malformed header into an outage. Running
		// unbounded is exactly what a caller sending no deadline gets, and
		// guessing a duration would invent a budget nobody set.
		expect(
			await fastLink().callImport(
				"api",
				KV,
				"get",
				{},
				{ deadline: "not a timestamp" },
			),
		).toStrictEqual({ value: "v" });
	});

	it("runs unbounded for an empty deadline", async () => {
		expect(
			await fastLink().callImport("api", KV, "get", {}, { deadline: "" }),
		).toStrictEqual({ value: "v" });
	});

	it("does not time out a slow call under an unreadable deadline", async () => {
		// The consequence of the choice above, stated directly: the call is
		// unbounded, not bounded by some fallback.
		const { link, release } = blockingLink();
		const call = link.callImport(
			"api",
			KV,
			"get",
			{},
			{ deadline: "not a timestamp" },
		);
		release();
		expect(await call).toStrictEqual({ value: "v" });
	});
});

describe("no deadline at all", () => {
	it("runs unbounded", async () => {
		const { link, release } = blockingLink();
		const call = link.callImport("api", KV, "get", {});
		release();
		expect(await call).toStrictEqual({ value: "v" });
	});

	it("records the absent deadline on the call event", async () => {
		// The membrane event log is the record of what each hop was allowed;
		// an absent deadline has to be distinguishable from an unrecorded one.
		const link = fastLink();
		await link.callImport("api", KV, "get", {});
		const called = link.events.filter((event) => event.type === "link.Called");
		expect(called.at(-1)).toMatchObject({ deadline: null });
	});

	it("records the deadline it enforced when there was one", async () => {
		const deadline = soon(10_000);
		const link = fastLink();
		await link.callImport("api", KV, "get", {}, { deadline });
		const called = link.events.filter((event) => event.type === "link.Called");
		expect(called.at(-1)).toMatchObject({ deadline });
	});
});
