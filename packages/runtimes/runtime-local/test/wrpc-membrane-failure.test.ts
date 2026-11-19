import assert from "node:assert/strict";
import {
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
} from "@hobo/core";
import { describe, expect, it, vi } from "vitest";
import {
	AmbiguousCommitError,
	classifyToRuntimeError,
	createInProcessTransport,
	createJsonWitCodec,
	createWrpcLinkLayer,
	DeadlineExceededError,
	MembraneBackpressureError,
	type RuntimeMembraneError,
} from "../src/index.js";
import { isJsonObject, isJsonString, type JsonValue } from "../src/json.js";

const KV = parseInterfaceId("wasi:keyvalue/store@0.2.0");
const FUTURE_DEADLINE = "2999-01-01T00:00:00.000Z";
const PAST_DEADLINE = "2000-01-01T00:00:00.000Z";

function kvPin() {
	return {
		interfaceId: KV,
		stability: "stable" as const,
		versions: [parseWireVersion("0.2.0")],
	};
}

interface MembraneHandlerMap {
	readonly [operation: string]: (
		payload: JsonValue,
	) => JsonValue | Promise<JsonValue>;
}

function createLayer(
	handlers: MembraneHandlerMap,
	options: { maxInFlight?: number; clock?: { nowMs(): number } } = {},
) {
	const store = new ProviderHandlerStore();
	const transport = createInProcessTransport({
		store,
		codec: createJsonWitCodec(),
	});
	const layer = createWrpcLinkLayer({
		transport,
		compatibilityFloor: "0.2.0",
		store,
		...(options.maxInFlight !== undefined
			? { maxInFlight: options.maxInFlight }
			: undefined),
		...(options.clock !== undefined ? { clock: options.clock } : undefined),
	});
	layer.registerComponent({ id: "api", imports: [kvPin()] });
	layer.registerProvider({
		id: "local-kv",
		exports: [kvPin()],
		handlers: { [KV]: handlers },
	});
	layer.establishLink({
		componentId: "api",
		importInterface: KV,
		providerId: "local-kv",
		exportInterface: KV,
	});
	return layer;
}

describe("membrane failure semantics (S1-23)", () => {
	it("a fast call under its deadline still succeeds", async () => {
		const layer = createLayer({
			get: (payload) => {
				if (!isJsonObject(payload) || !isJsonString(payload.key)) {
					throw new Error("key required");
				}
				return { value: `stored:${payload.key}` };
			},
		});

		const result = await layer.callImport(
			"api",
			KV,
			"get",
			{ key: "s" },
			{
				deadline: FUTURE_DEADLINE,
			},
		);

		expect(result).toEqual({ value: "stored:s" });
		expect(layer.events.at(-1)?.type).toBe("link.Called");
	});

	it("rejects an already-expired deadline without invoking the provider", async () => {
		const get = vi.fn(async () => ({ value: "too-late" }));
		const layer = createLayer({ get });

		let caught: unknown;
		try {
			await layer.callImport(
				"api",
				KV,
				"get",
				{ key: "s" },
				{
					deadline: PAST_DEADLINE,
				},
			);
		} catch (error) {
			caught = error;
		}

		assert.ok(caught instanceof DeadlineExceededError);
		expect(caught.kind).toBe("cancelled");
		expect(get).not.toHaveBeenCalled();
		expect(classifyToRuntimeError(caught).tag).toBe("cancelled");
		expect(layer.events.some((event) => event.type === "link.Called")).toBe(
			false,
		);
	});

	it("a saturated membrane sheds load with a typed retryable backpressure error", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const layer = createLayer(
			{
				get: async () => {
					await gate;
					return { value: "eventually" };
				},
			},
			{ maxInFlight: 1 },
		);

		const first = layer.callImport("api", KV, "get", { key: "a" });

		let caught: unknown;
		try {
			await layer.callImport("api", KV, "get", { key: "b" });
		} catch (error) {
			caught = error;
		}

		assert.ok(caught instanceof MembraneBackpressureError);
		expect(caught.kind).toBe("retryable");
		expect(caught.retryable).toBe(true);
		expect(classifyToRuntimeError(caught).tag).toBe("retryable");

		release?.();
		await expect(first).resolves.toEqual({ value: "eventually" });
	});

	it("a mid-call crash with unknown commit surfaces an explicit ambiguous-commit", async () => {
		const layer = createLayer({
			put: () => {
				throw new AmbiguousCommitError({
					providerId: "local-kv",
					operation: "put",
					importInterface: KV,
					reason: "process crashed after append dispatch",
				});
			},
		});

		let caught: unknown;
		try {
			await layer.callImport("api", KV, "put", { key: "a", value: "1" });
		} catch (error) {
			caught = error;
		}

		assert.ok(caught instanceof AmbiguousCommitError);
		expect(caught.kind).toBe("ambiguous-commit");
		expect(caught.ambiguousCommit).toBe(true);
		expect(classifyToRuntimeError(caught).tag).toBe("ambiguous-commit");
	});

	it("classifies every failure onto a WIT runtime-error kind, failing closed to fatal", () => {
		expect(
			classifyToRuntimeError(
				Object.assign(new Error("wire"), { code: "version-incompatible" }),
			).tag,
		).toBe("version-incompatible");
		expect(
			classifyToRuntimeError(Object.assign(new Error("busy"), { status: 503 }))
				.tag,
		).toBe("retryable");
		expect(
			classifyToRuntimeError(
				Object.assign(new Error("unknown result"), { ambiguousCommit: true }),
			).tag,
		).toBe("ambiguous-commit");
		expect(classifyToRuntimeError(new Error("boom")).tag).toBe("fatal");
	});

	it("every typed membrane error lowers to the WIT runtime-error variant shape", () => {
		const errors: RuntimeMembraneError[] = [
			new DeadlineExceededError({
				componentId: "api",
				importInterface: KV,
				operation: "get",
				deadline: PAST_DEADLINE,
				deadlineMs: 0,
				observedNowMs: 1,
			}),
			new MembraneBackpressureError({
				providerId: "local-kv",
				operation: "get",
				importInterface: KV,
				maxInFlight: 1,
				inFlight: 1,
			}),
			new AmbiguousCommitError({
				providerId: "local-kv",
				operation: "put",
				importInterface: KV,
			}),
		];

		for (const error of errors) {
			const variant = error.toVariant();
			expect(variant.tag).toBe(error.kind);
			expect(isJsonString(variant.val)).toBe(true);
		}
	});
});
