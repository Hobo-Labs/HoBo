import {
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
} from "@hobo/core";
import { afterEach, expect, it, vi } from "vitest";
import { createInProcessTransport } from "../src/wrpc/in-process-transport.js";
import { createWrpcLinkLayer } from "../src/wrpc/link-layer.js";

const outer = parseInterfaceId("hobo:example/outer@0.2.0");
const inner = parseInterfaceId("hobo:example/inner@0.2.0");
const pin = (interfaceId: typeof outer) => ({
	interfaceId,
	stability: "stable" as const,
	versions: [parseWireVersion("0.2.0")],
});

function setup(childDeadline?: string, onChildAbort?: () => void) {
	const store = new ProviderHandlerStore();
	const link = createWrpcLinkLayer({
		transport: createInProcessTransport({ store }),
		compatibilityFloor: "0.2.0",
		store,
	});
	link.registerComponent({ id: "api", imports: [pin(outer), pin(inner)] });
	link.registerProvider({
		id: "outer",
		exports: [pin(outer)],
		handlers: {
			[outer]: {
				call: async () => {
					await Promise.resolve();
					return link.callImport(
						"api",
						inner,
						"get",
						{},
						{
							deadline: childDeadline ?? null,
						},
					);
				},
			},
		},
	});
	link.registerProvider({
		id: "inner",
		exports: [pin(inner)],
		handlers: {
			[inner]: {
				get: async (_payload, context) => {
					if (onChildAbort) {
						const signal = context.signal;
						if (!signal) throw new Error("provider signal missing");
						await new Promise<void>((_resolve, reject) => {
							signal.addEventListener(
								"abort",
								() => {
									onChildAbort();
									reject(signal.reason);
								},
								{ once: true },
							);
						});
					}
					return { deadline: context.deadline };
				},
			},
		},
	});
	for (const [providerId, interfaceId] of [
		["outer", outer],
		["inner", inner],
	] as const) {
		link.establishLink({
			componentId: "api",
			providerId,
			importInterface: interfaceId,
			exportInterface: interfaceId,
		});
	}
	return link;
}

afterEach(() => vi.useRealTimers());

it.each([
	{ parent: 10_000, child: undefined, expected: 10_000 },
	{ parent: 10_000, child: 5_000, expected: 5_000 },
	{ parent: 10_000, child: 20_000, expected: 10_000 },
	{ parent: undefined, child: 5_000, expected: 5_000 },
])("uses the earliest parent or child deadline", async ({
	parent,
	child,
	expected,
}) => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
	const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
	const link = setup(child === undefined ? undefined : iso(child));
	await expect(
		link.callImport(
			"api",
			outer,
			"call",
			{},
			{
				deadline: parent === undefined ? null : iso(parent),
			},
		),
	).resolves.toEqual({ deadline: iso(expected) });
});

it("keeps deadlines isolated across concurrent calls", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
	const link = setup();
	const first = new Date(Date.now() + 5_000).toISOString();
	const second = new Date(Date.now() + 10_000).toISOString();
	await expect(
		Promise.all([
			link.callImport("api", outer, "call", {}, { deadline: first }),
			link.callImport("api", outer, "call", {}, { deadline: second }),
		]),
	).resolves.toEqual([{ deadline: first }, { deadline: second }]);
	await expect(link.callImport("api", inner, "get")).resolves.toEqual({
		deadline: null,
	});
});

it("cancels nested work when the inherited deadline expires", async () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
	let aborted = false;
	const link = setup(undefined, () => {
		aborted = true;
	});
	const deadline = new Date(Date.now() + 1_000).toISOString();
	const result = link
		.callImport("api", outer, "call", {}, { deadline })
		.catch((error) => error);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(await result).toMatchObject({ code: "deadline-exceeded" });
	expect(aborted).toBe(true);
});
