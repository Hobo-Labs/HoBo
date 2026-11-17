import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import {
	type AlchemyTargetInput,
	alchemyTarget,
	createAlchemyIacProvider,
	type FinancialPlan,
	TargetSchema,
} from "../src/index.js";

type Widget = Resource<"Spec.Widget", Record<string, never>, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");

function rawTarget(): AlchemyTargetInput {
	return {
		targetId: "t",
		tenantId: "tenant",
		stackName: "App",
		stage: "test",
		programResourceId: "app",
		sourceDigest: `sha256:${"a".repeat(64)}`,
		inventoryEvidenceRef: "inventory",
		resources: [
			{
				resourceId: "widget",
				resourceType: "Spec.Widget",
				providerId: "provider",
				providerAccountRef: "account",
				productId: "widget",
			},
		],
	};
}

function providerOptions(target = alchemyTarget(rawTarget())) {
	const providers = Provider.succeed(Widget, {
		reconcile: () => Effect.succeed({ id: "widget" }),
		delete: () => Effect.void,
	});
	const stack = Stack(
		"App",
		{
			providers,
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			yield* Widget("widget", {});
			return {};
		}),
	);
	return {
		stack,
		target,
		runtimeLayer: Layer.merge(Alchemist.layer(), providers),
		runtimeDirectory: "/tmp",
		financial: {
			assess: (plan: FinancialPlan) => ({ plan }),
			admit: async () => {
				throw new Error("unexpected admission");
			},
			uncertain: () => {},
		},
	};
}

describe("Alchemy target input boundary", () => {
	it("copies complete raw and generated data without retaining mutable callers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-iac-input-"));
		const oldHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = directory;
		try {
			const raw = rawTarget();
			const target = alchemyTarget(raw);
			const rawRow = raw.resources[0];
			if (rawRow === undefined) throw new Error("missing fixture row");
			rawRow.productId = "changed";
			expect(target.resources[0]?.productId).toBe("widget");
			const provider = createAlchemyIacProvider(providerOptions(target));
			const targetRow = target.resources[0];
			if (targetRow === undefined) throw new Error("missing target row");
			targetRow.productId = "changed-again";
			const assessment = await provider.assessPricing({
				programId: "p",
				deploymentId: "d",
				resourceId: "app",
				provider: "provider",
				driver: "external",
				action: "preview",
				stackName: "App",
			});
			expect(assessment.plan.resources[0]?.productId).toBe("widget");
		} finally {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects unknown, hidden, accessor-backed and malformed fields without running getters", () => {
		let getters = 0;
		const accessor = { ...rawTarget() };
		Object.defineProperty(accessor, "tenantId", {
			enumerable: true,
			get: () => {
				getters++;
				return "tenant";
			},
		});
		const hidden = { ...rawTarget() };
		Object.defineProperty(hidden, "hidden", { value: "x", enumerable: false });
		const symbol = Object.assign(rawTarget(), { [Symbol("extra")]: true });
		const wrongType = { ...rawTarget(), sourceDigest: 42 };
		const unknown = { ...rawTarget(), target_id: "shadow" };
		for (const input of [accessor, hidden, symbol, wrongType, unknown]) {
			// SAFETY: deliberately malformed values exercise the runtime boundary.
			expect(() => alchemyTarget(input as AlchemyTargetInput)).toThrow(
				"TARGET_INVALID",
			);
		}
		expect(getters).toBe(0);
	});

	it("rejects unknown protobuf wire fields instead of silently dropping them", () => {
		const encoded = toBinary(TargetSchema, alchemyTarget(rawTarget()));
		const wire = new Uint8Array(encoded.length + 3);
		wire.set(encoded);
		wire.set([0x98, 0x06, 0x01], encoded.length);
		const decoded = fromBinary(TargetSchema, wire);
		expect(Object.hasOwn(decoded, "$unknown")).toBe(true);
		expect(() => createAlchemyIacProvider(providerOptions(decoded))).toThrow(
			"TARGET_INVALID",
		);
	});

	it("refuses sparse, decorated, accessor and oversized resource arrays", () => {
		let getterCalls = 0;
		const sparse = Array(1);
		const decorated = Object.assign([rawTarget().resources[0]], {
			extra: true,
		});
		const accessor = [rawTarget().resources[0]];
		Object.defineProperty(accessor, "0", {
			enumerable: true,
			get: () => {
				getterCalls++;
				return rawTarget().resources[0];
			},
		});
		const huge = Array(1_000_000_000);
		for (const resources of [sparse, decorated, accessor, huge]) {
			// SAFETY: each intentionally invalid collection is supplied at the I/O boundary.
			expect(() =>
				alchemyTarget({ ...rawTarget(), resources } as AlchemyTargetInput),
			).toThrow("TARGET_INVALID");
		}
		expect(getterCalls).toBe(0);
	});

	it("rejects proxies before invoking traps and never reads an accessor target option", () => {
		let traps = 0;
		const proxy = new Proxy(rawTarget(), {
			ownKeys() {
				traps++;
				throw new Error("trap");
			},
		});
		expect(() => alchemyTarget(proxy)).toThrow("TARGET_INVALID");
		const options = providerOptions();
		Object.defineProperty(options, "target", {
			enumerable: true,
			get() {
				traps++;
				return alchemyTarget(rawTarget());
			},
		});
		expect(() => createAlchemyIacProvider(options)).toThrow("OPTIONS_INVALID");
		const stackAccessor = providerOptions();
		Object.defineProperty(stackAccessor, "stack", {
			enumerable: true,
			get() {
				traps++;
				throw new Error("stack accessor must not run");
			},
		});
		expect(() => createAlchemyIacProvider(stackAccessor)).toThrow(
			"OPTIONS_INVALID",
		);
		const optionsProxy = new Proxy(providerOptions(), {
			get() {
				traps++;
				throw new Error("options proxy must not run");
			},
			ownKeys() {
				traps++;
				throw new Error("options proxy must not run");
			},
		});
		expect(() => createAlchemyIacProvider(optionsProxy)).toThrow(
			"OPTIONS_INVALID",
		);
		expect(traps).toBe(0);
	});
});
