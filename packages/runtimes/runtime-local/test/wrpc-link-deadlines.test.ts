import {
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
} from "@hobo/core";
import { describe, expect, it, vi } from "vitest";

import {
	createInProcessTransport,
	createJsonWitCodec,
	createWrpcLinkLayer,
	DeadlineExceededError,
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
	const nowMs = options.nowMs;
	const config: Parameters<typeof createWrpcLinkLayer>[0] = {
		transport: createInProcessTransport({ store, codec: createJsonWitCodec() }),
		compatibilityFloor: FLOOR,
		store,
	};
	if (nowMs !== undefined) config.clock = { nowMs: () => nowMs };
	const link = createWrpcLinkLayer(config);
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
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
	});
	link.establishLink({
		componentId: "api",
		providerId: "kv",
		importInterface: KV,
		exportInterface: KV,
	});
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
	});
	link.establishLink({
		componentId: "api",
		providerId: "kv",
		importInterface: KV,
		exportInterface: KV,
	});
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
		await expect(call).rejects.toMatchObject({ deadline });
		release();
	});

	it("releases the in-flight slot when the provider completes", async () => {
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
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
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
		});
		link.establishLink({
			componentId: "api",
			providerId: "kv",
			importInterface: KV,
			exportInterface: KV,
		});
		await link
			.callImport("api", KV, "get", {}, { deadline: soon(20) })
			.catch(() => undefined);
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
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

	it("rejects an expired deadline before a fast provider can run", async () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		await expect(
			fastLink().callImport("api", KV, "get", {}, { deadline: past }),
		).rejects.toBeInstanceOf(DeadlineExceededError);
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

	it("clears the deadline timer after completion", async () => {
		vi.useFakeTimers();
		try {
			const link = fastLink();
			await link.callImport("api", KV, "get", {}, { deadline: soon(600_000) });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
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
		});
		link.establishLink({
			componentId: "api",
			providerId: "kv",
			importInterface: KV,
			exportInterface: KV,
		});
		expect(
			await link.callImport("api", KV, "get", {}, { deadline: soon(10_000) }),
		).toStrictEqual({ value: "v" });
	});
});

describe("a deadline the link cannot read", () => {
	it("rejects an unreadable deadline", async () => {
		await expect(
			fastLink().callImport(
				"api",
				KV,
				"get",
				{},
				{ deadline: "not a timestamp" },
			),
		).rejects.toThrow("wrpc.invalid_deadline");
	});

	it("rejects an empty deadline", async () => {
		await expect(
			fastLink().callImport("api", KV, "get", {}, { deadline: "" }),
		).rejects.toThrow("wrpc.invalid_deadline");
	});

	it("refuses a slow call under an unreadable deadline", async () => {
		const { link, release } = blockingLink();
		const call = link.callImport(
			"api",
			KV,
			"get",
			{},
			{ deadline: "not a timestamp" },
		);
		await expect(call).rejects.toThrow("wrpc.invalid_deadline");
		release();
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
