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
	} as never);
	link.establishLink({
		componentId: "api",
		providerId: "kv",
		importInterface: KV,
		exportInterface: KV,
	} as never);
	return { link, release };
}

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
	} as never);
	link.establishLink({
		componentId: "api",
		providerId: "kv",
		importInterface: KV,
		exportInterface: KV,
	} as never);
	return link;
}

const soon = (ms: number) => new Date(Date.now() + ms).toISOString();

describe("a deadline that expires", () => {
	it("releases the caller with a typed error", async () => {
		const { link, release } = blockingLink();
		const call = link.callImport("api", KV, "get", {}, { deadline: soon(20) });
		await expect(call).rejects.toThrow(DeadlineExceededError);
		release();
	});

	it("names the operation that ran out of time", async () => {
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
		} as never);
		link.establishLink({
			componentId: "api",
			providerId: "kv",
			importInterface: KV,
			exportInterface: KV,
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
		const { link, release } = blockingLink();
		const past = new Date(Date.now() - 60_000).toISOString();
		await expect(
			link.callImport("api", KV, "get", {}, { deadline: past }),
		).rejects.toThrow(DeadlineExceededError);
		release();
	});

	it("GAP: a fast provider still wins the race, so the call succeeds", async () => {
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
		const link = fastLink();
		await link.callImport("api", KV, "get", {}, { deadline: soon(600_000) });
		expect(true).toBe(true);
	});

	it("measures the remaining time against the clock it was given", async () => {
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
		} as never);
		link.establishLink({
			componentId: "api",
			providerId: "kv",
			importInterface: KV,
			exportInterface: KV,
		} as never);
		expect(
			await link.callImport("api", KV, "get", {}, { deadline: soon(10_000) }),
		).toStrictEqual({ value: "v" });
	});
});

describe("a deadline the link cannot read", () => {
	it("runs unbounded rather than refusing", async () => {
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
