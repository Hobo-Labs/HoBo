import {
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
} from "@hobo/core";
import { afterEach, expect, it, vi } from "vitest";
import {
	DeadlineExceededError,
	MembraneBackpressureError,
	RuntimeMembraneError,
} from "../src/failure/taxonomy.js";
import { createInProcessTransport } from "../src/wrpc/in-process-transport.js";
import { createWrpcLinkLayer, type LinkClock } from "../src/wrpc/link-layer.js";

const iface = parseInterfaceId("wasi:keyvalue/store@0.2.0");
const pin = {
	interfaceId: iface,
	stability: "stable" as const,
	versions: [parseWireVersion("0.2.0")],
};

function setup(
	handler: () => Promise<{ value: string }>,
	maxInFlight = 1,
	clock?: LinkClock,
) {
	const store = new ProviderHandlerStore();
	const config: Parameters<typeof createWrpcLinkLayer>[0] = {
		transport: createInProcessTransport({ store }),
		compatibilityFloor: "0.2.0",
		store,
		maxInFlight,
	};
	if (clock !== undefined) config.clock = clock;
	const link = createWrpcLinkLayer(config);
	link.registerComponent({ id: "api", imports: [pin] });
	link.registerProvider({
		id: "kv",
		exports: [pin],
		handlers: { [iface]: { get: handler } },
	});
	link.establishLink({
		componentId: "api",
		providerId: "kv",
		importInterface: iface,
		exportInterface: iface,
	});
	return link;
}

afterEach(() => vi.useRealTimers());

it("does not dispatch a call whose deadline has elapsed", async () => {
	let calls = 0;
	const link = setup(async () => {
		calls += 1;
		return { value: "changed" };
	});
	const deadline = new Date(Date.now() - 1000).toISOString();
	await expect(
		link.callImport("api", iface, "get", {}, { deadline }),
	).rejects.toBeInstanceOf(DeadlineExceededError);
	expect(calls).toBe(0);
	expect(link.events.some((event) => event.type === "link.Called")).toBe(false);
});

it.each([
	"",
	"not a timestamp",
	"0",
	"2030-02-30T12:00:00Z",
	"2030-01-01T24:00:00Z",
	"2030-01-01T00:00:00+25:00",
])("rejects an unreadable deadline without dispatching: %s", async (deadline) => {
	let calls = 0;
	const link = setup(async () => {
		calls += 1;
		return { value: "changed" };
	});
	await expect(
		link.callImport("api", iface, "get", {}, { deadline }),
	).rejects.toBeInstanceOf(RuntimeMembraneError);
	expect(calls).toBe(0);
});

it("expires a long deadline after the full interval", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const link = setup(async () => {
		await gate;
		return { value: "ok" };
	});
	const duration = 30 * 24 * 60 * 60 * 1000;
	const deadline = new Date(Date.now() + duration).toISOString();
	const call = link.callImport("api", iface, "get", {}, { deadline });
	const result = call.then(
		() => "resolved",
		(error) => (error instanceof DeadlineExceededError ? "expired" : "other"),
	);
	await vi.advanceTimersByTimeAsync(2_147_483_647);
	let settled = false;
	void result.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	await vi.advanceTimersByTimeAsync(duration - 2_147_483_647);
	expect(await result).toBe("expired");
	release();
});

it("accepts a valid offset deadline", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
	const link = setup(async () => ({ value: "ok" }));
	await expect(
		link.callImport(
			"api",
			iface,
			"get",
			{},
			{ deadline: "2030-01-01T01:00:30+01:00" },
		),
	).resolves.toEqual({ value: "ok" });
});

it("rejects work that settles after its deadline before the timer can run", async () => {
	let now = Date.parse("2030-01-01T00:00:00.000Z");
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const link = setup(
		async () => {
			await gate;
			return { value: "late" };
		},
		1,
		{ nowMs: () => now },
	);
	const deadline = new Date(now + 1_000).toISOString();
	const result = link.callImport("api", iface, "get", {}, { deadline });
	now += 1_001;
	release();
	await expect(result).rejects.toBeInstanceOf(DeadlineExceededError);
});

it("fails closed when the clock becomes unavailable after dispatch", async () => {
	let reads = 0;
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const link = setup(
		async () => {
			await gate;
			return { value: "ok" };
		},
		1,
		{
			nowMs: () => {
				reads += 1;
				if (reads > 1) throw new Error("private clock failure");
				return Date.now();
			},
		},
	);
	const deadline = new Date(Date.now() + 60_000).toISOString();
	await expect(
		link.callImport("api", iface, "get", {}, { deadline }),
	).rejects.toMatchObject({ kind: "fatal", message: "wrpc.invalid_clock" });
	await expect(link.callImport("api", iface, "get", {})).rejects.toBeInstanceOf(
		MembraneBackpressureError,
	);
	release();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await expect(link.callImport("api", iface, "get", {})).resolves.toEqual({
		value: "ok",
	});
});

it("rejects a non-finite clock before dispatch", async () => {
	let calls = 0;
	const link = setup(
		async () => {
			calls += 1;
			return { value: "ok" };
		},
		1,
		{ nowMs: () => Number.NaN },
	);
	await expect(
		link.callImport(
			"api",
			iface,
			"get",
			{},
			{ deadline: "2030-01-01T00:00:00.000Z" },
		),
	).rejects.toMatchObject({ kind: "fatal", message: "wrpc.invalid_clock" });
	expect(calls).toBe(0);
});

it("does not overflow a long deadline into an immediate timeout", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const link = setup(async () => {
		await gate;
		return { value: "ok" };
	});
	const deadline = new Date(
		Date.now() + 30 * 24 * 60 * 60 * 1000,
	).toISOString();
	let state = "pending";
	const call = link.callImport("api", iface, "get", {}, { deadline });
	void call.then(
		() => {
			state = "resolved";
		},
		() => {
			state = "rejected";
		},
	);
	await vi.advanceTimersByTimeAsync(20);
	expect(state).toBe("pending");
	release();
	await expect(call).resolves.toEqual({ value: "ok" });
});

it("holds the provider slot until timed-out work actually settles", async () => {
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const link = setup(async () => {
		await gate;
		return { value: "ok" };
	});
	const deadline = new Date(Date.now() + 20).toISOString();
	await expect(
		link.callImport("api", iface, "get", {}, { deadline }),
	).rejects.toBeInstanceOf(DeadlineExceededError);
	const second = link.callImport("api", iface, "get", {});
	const outcome = await Promise.race([
		second.then(
			() => "resolved",
			(error) =>
				error instanceof MembraneBackpressureError ? "backpressure" : "other",
		),
		new Promise<string>((resolve) => setTimeout(() => resolve("running"), 50)),
	]);
	release();
	await second.catch(() => undefined);
	expect(outcome).toBe("backpressure");
	await new Promise<void>((resolve) => setImmediate(resolve));
	await expect(link.callImport("api", iface, "get", {})).resolves.toEqual({
		value: "ok",
	});
});
