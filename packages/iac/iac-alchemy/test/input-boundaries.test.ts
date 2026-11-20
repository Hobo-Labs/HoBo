import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types } from "node:util";
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
	captureAlchemyProgram,
	createAlchemyIacProvider,
	type FinancialPlan,
	type FinancialPort,
	TargetSchema,
} from "../src/index.js";
import { digestData } from "../src/plan.js";
import { safeAlchemyState } from "../src/state-identity.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

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
		stateOwnership: testStateOwnership,
		composite: {
			proofRef: "test:no-source",
			environmentDigest: `sha256:${"e".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: () => true,
		},
		runtimeLayer: Layer.merge(Alchemist.layer(), providers),
		runtimeDirectory: "/tmp",
		financial: {
			assess: (plan: FinancialPlan) => ({ plan }),
			admit: async () => {
				throw new Error("unexpected admission");
			},
			revalidate: () => false,
			uncertain: () => {},
		},
	};
}

describe("Alchemy target input boundary", () => {
	it("rejects accessor-backed secret guard data without reading inherited descriptor values", () => {
		const options = providerOptions();
		let traps = 0;
		const composite = Object.defineProperty(
			{ ...options.composite },
			"secretFingerprint",
			{
				enumerable: true,
				get() {
					traps++;
					throw new Error("secret getter");
				},
			},
		);
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		let error: unknown;
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					traps++;
					throw new Error("inherited value");
				},
			});
			try {
				createAlchemyIacProvider({ ...options, composite });
			} catch (caught) {
				error = caught;
			}
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", previous);
		}
		expect(error).toMatchObject({ code: "COMPOSITE_ENVIRONMENT_UNVERIFIED" });
		expect(traps).toBe(0);
	});
	it("never accepts inherited entries in a descriptor map", () => {
		const names = ["fqn", "downstream", "0"] as const;
		const previous = names.map((key) =>
			Object.getOwnPropertyDescriptor(Object.prototype, key),
		);
		const sparse: unknown[] = [];
		sparse.length = 1;
		const digestSparse: unknown[] = [];
		digestSparse.length = 1;
		Object.defineProperty(sparse, "extra", {
			enumerable: true,
			value: "ignored",
		});
		Object.defineProperty(Object.prototype, "fqn", {
			configurable: true,
			writable: true,
			value: { value: "widget" },
		});
		Object.defineProperty(Object.prototype, "downstream", {
			configurable: true,
			writable: true,
			value: { value: [] },
		});
		Object.defineProperty(Object.prototype, "0", {
			configurable: true,
			writable: true,
			value: { value: "other" },
		});
		let missing = true;
		let array = true;
		let error: unknown;
		try {
			missing = safeAlchemyState({}, "widget");
			array = safeAlchemyState({ fqn: "widget", downstream: sparse }, "widget");
			try {
				digestData(digestSparse);
			} catch (caught) {
				error = caught;
			}
		} finally {
			for (let index = 0; index < names.length; index++) {
				const key = names[index];
				if (key === undefined) continue;
				const old = previous[index];
				if (old === undefined) Reflect.deleteProperty(Object.prototype, key);
				else Object.defineProperty(Object.prototype, key, old);
			}
		}
		expect(missing).toBe(false);
		expect(array).toBe(false);
		expect(error).toMatchObject({ code: "PLAN_UNINSPECTABLE" });
	});

	it("uses the captured proxy predicate even if its public property is replaced", () => {
		let traps = 0;
		const target = new Proxy(rawTarget(), {
			get() {
				traps++;
				throw new Error("get");
			},
			ownKeys() {
				traps++;
				throw new Error("keys");
			},
		});
		const previous = Object.getOwnPropertyDescriptor(types, "isProxy");
		Object.defineProperty(types, "isProxy", {
			configurable: true,
			writable: true,
			value: () => false,
		});
		let error: unknown;
		try {
			alchemyTarget(target);
		} catch (caught) {
			error = caught;
		} finally {
			if (previous !== undefined)
				Object.defineProperty(types, "isProxy", previous);
		}
		expect(error).toMatchObject({ code: "TARGET_INVALID" });
		expect(traps).toBe(0);
	});

	it("rejects accessor fields without consulting an inherited descriptor value", () => {
		let traps = 0;
		const accessor = () => {
			traps++;
			throw new Error("accessor ran");
		};
		const target = Object.defineProperty(rawTarget(), "tenantId", {
			enumerable: true,
			get: accessor,
		});
		const program = Object.defineProperty(
			{
				programId: "p",
				deploymentId: "d",
				resourceId: "app",
				provider: "provider",
				driver: "external",
				action: "apply",
				stackName: "App",
			},
			"programId",
			{ enumerable: true, get: accessor },
		);
		const state = Object.defineProperty({ downstream: [] }, "fqn", {
			enumerable: true,
			get: accessor,
		});
		const plan = Object.defineProperty({}, "field", {
			enumerable: true,
			get: accessor,
		});
		const options = providerOptions();
		Object.defineProperty(options.financial, "assess", {
			enumerable: true,
			get: accessor,
		});
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get: accessor,
		});
		const outcomes: unknown[] = [];
		/* oxlint-disable-next-line anti-slop/no-unknown-returns -- SAFETY: the test collects deliberately malformed boundary results for assertions after restoring Object.prototype. */
		const capture = (run: () => unknown) => {
			try {
				return run();
			} catch (error) {
				return error;
			}
		};
		try {
			outcomes.push(capture(() => alchemyTarget(target)));
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the accessor-backed program deliberately exercises the runtime boundary.
			outcomes.push(capture(() => captureAlchemyProgram(program as never)));
			outcomes.push(capture(() => digestData(plan)));
			outcomes.push(safeAlchemyState(state, "widget"));
			outcomes.push(capture(() => createAlchemyIacProvider(options)));
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", previous);
		}
		expect(outcomes[0]).toMatchObject({ code: "TARGET_INVALID" });
		expect(outcomes[1]).toMatchObject({ code: "PROGRAM_INVALID" });
		expect(outcomes[2]).toMatchObject({ code: "PLAN_UNINSPECTABLE" });
		expect(outcomes[3]).toBe(false);
		expect(outcomes[4]).toMatchObject({
			code: "FINANCIAL_AUTHORITY_UNAVAILABLE",
		});
		expect(traps).toBe(0);
	});

	it("captures actual financial callbacks and preserves their receiver without mutable bind or call", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-iac-financial-"));
		const oldHome = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = directory;
		let traps = 0;
		const calls: string[] = [];
		try {
			const financial: FinancialPort<{ marker: string }> = {
				assess() {
					expect(this).toBe(financial);
					calls.push("assess");
					return { marker: "original" };
				},
				async admit(requestId) {
					expect(this).toBe(financial);
					calls.push("admit");
					return {
						requestId,
						targetId: "t",
						status: "denied",
						code: "BUDGET_DENIED",
						message: "",
						budget: { evaluation: "denied", reservation: "not-created" },
					};
				},
				revalidate() {
					expect(this).toBe(financial);
					calls.push("revalidate");
					return true;
				},
				uncertain() {
					expect(this).toBe(financial);
					calls.push("uncertain");
				},
			};
			for (const callback of [
				financial.assess,
				financial.admit,
				financial.revalidate,
				financial.uncertain,
			])
				for (const key of ["bind", "call"])
					Object.defineProperty(callback, key, {
						get() {
							traps++;
							return () => () => true;
						},
					});
			const provider = createAlchemyIacProvider({
				...providerOptions(),
				financial,
				route: routeFixture().port,
				resolveRoute: ({ requestId }) => ({
					requestId: requestId ?? "request",
					operation: testOperation,
				}),
			});
			financial.assess = () => ({ marker: "substituted" });
			financial.admit = async (requestId) => ({
				requestId,
				targetId: "t",
				status: "admitted",
				code: "",
				message: "",
				budget: { evaluation: "allowed", reservation: "held" },
				reservation: { reservationId: `iac:${requestId}` },
			});
			const program = {
				programId: "p",
				deploymentId: "d",
				resourceId: "app",
				provider: "provider",
				driver: "external",
				action: "apply" as const,
				stackName: "App",
				operationGeneration: "generation-1",
			};
			expect(await provider.assessPricing(program)).toMatchObject({
				marker: "original",
			});
			await expect(
				provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ code: "BUDGET_DENIED" });
			expect(calls).toEqual(["assess", "admit"]);
			expect(traps).toBe(0);
		} finally {
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"assess",
		"admit",
		"uncertain",
	] as const)("rejects a proxied or accessor-backed %s callback before traps", (key) => {
		for (const mode of ["container", "callback", "accessor"] as const) {
			let traps = 0;
			const options = providerOptions();
			const financial = { ...options.financial };
			if (mode === "callback")
				Object.defineProperty(financial, key, {
					enumerable: true,
					value: new Proxy(() => true, {
						apply() {
							traps++;
							throw new Error("trap");
						},
					}),
				});
			if (mode === "accessor")
				Object.defineProperty(financial, key, {
					enumerable: true,
					get() {
						traps++;
						throw new Error("trap");
					},
				});
			const candidate =
				mode === "container"
					? new Proxy(financial, {
							get() {
								traps++;
								throw new Error("trap");
							},
							getOwnPropertyDescriptor() {
								traps++;
								throw new Error("trap");
							},
						})
					: financial;
			expect(() =>
				createAlchemyIacProvider({ ...options, financial: candidate }),
			).toThrow("FINANCIAL_AUTHORITY_UNAVAILABLE");
			expect(traps).toBe(0);
		}
	});

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
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: deliberately malformed values exercise the runtime boundary.
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
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: each intentionally invalid collection is supplied at the I/O boundary.
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
