import {
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
} from "@hobo/core";
import { afterEach, expect, it, vi } from "vitest";
import { DeadlineExceededError } from "../src/failure/taxonomy.js";
import { createInProcessTransport } from "../src/wrpc/in-process-transport.js";
import { createWrpcLinkLayer, type LinkClock } from "../src/wrpc/link-layer.js";

const iface = parseInterfaceId("wasi:keyvalue/store@0.2.0");
const pin = {
	interfaceId: iface,
	stability: "stable" as const,
	versions: [parseWireVersion("0.2.0")],
};

function setup(clock?: LinkClock) {
	const store = new ProviderHandlerStore();
	const config: Parameters<typeof createWrpcLinkLayer>[0] = {
		transport: createInProcessTransport({ store }),
		compatibilityFloor: "0.2.0",
		store,
		maxInFlight: 1,
	};
	if (clock) config.clock = clock;
	const link = createWrpcLinkLayer(config);
	let signal: AbortSignal | undefined;
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	link.registerComponent({ id: "api", imports: [pin] });
	link.registerProvider({
		id: "kv",
		exports: [pin],
		handlers: {
			[iface]: {
				hold: async (_payload, context) => {
					signal = context.signal;
					if (!signal) throw new Error("provider signal missing");
					await new Promise<void>((resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal?.reason), {
							once: true,
						});
						void gate.then(resolve);
					});
					return { value: "done" };
				},
				get: async () => ({ value: "ready" }),
			},
		},
	});
	link.establishLink({
		componentId: "api",
		providerId: "kv",
		importInterface: iface,
		exportInterface: iface,
	});
	return { link, release, signal: () => signal };
}

afterEach(() => vi.useRealTimers());

it("aborts cooperative provider work at the deadline and frees its slot", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
	const runtime = setup();
	const call = runtime.link.callImport(
		"api",
		iface,
		"hold",
		{},
		{
			deadline: new Date(Date.now() + 1_000).toISOString(),
		},
	);
	const result = call.catch((error) => error);
	expect(runtime.signal()?.aborted).toBe(false);
	await vi.advanceTimersByTimeAsync(1_000);
	const error = await result;
	expect(error).toBeInstanceOf(DeadlineExceededError);
	expect(runtime.signal()?.reason).toBe(error);
	await expect(runtime.link.callImport("api", iface, "get")).resolves.toEqual({
		value: "ready",
	});
});

it("aborts the provider signal if work settles after its deadline", async () => {
	let now = Date.parse("2030-01-01T00:00:00.000Z");
	const runtime = setup({ nowMs: () => now });
	const call = runtime.link.callImport(
		"api",
		iface,
		"hold",
		{},
		{
			deadline: new Date(now + 1_000).toISOString(),
		},
	);
	now += 1_001;
	runtime.release();
	const error = await call.catch((cause) => cause);
	expect(error).toBeInstanceOf(DeadlineExceededError);
	expect(runtime.signal()?.reason).toBe(error);
});

it("does not abort a provider whose work completed before the deadline", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
	const runtime = setup();
	const call = runtime.link.callImport(
		"api",
		iface,
		"hold",
		{},
		{
			deadline: new Date(Date.now() + 1_000).toISOString(),
		},
	);
	runtime.release();
	await expect(call).resolves.toEqual({ value: "done" });
	await vi.advanceTimersByTimeAsync(2_000);
	expect(runtime.signal()?.aborted).toBe(false);
});
