import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types } from "node:util";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AlchemyStateOwnership,
	alchemyTarget,
	createAlchemyIacProvider,
} from "../src/index.js";
import type { AlchemyCompositeGuard } from "../src/plan.js";
import type { FinancialPort, IacRoutePort } from "../src/port.js";
import {
	captureAlchemySourceFence,
	captureAlchemySourceRequirements,
} from "../src/source-fence.js";
import { routeFixture, testOperation } from "./route-fixture.js";

type Widget = Resource<"Spec.Widget", object, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");
const program = {
	programId: "p",
	deploymentId: "d",
	resourceId: "app",
	provider: "test",
	driver: "external",
	action: "apply" as const,
	stackName: "App",
	operationGeneration: "generation-1",
};
const dirs: string[] = [];
const priorHome = process.env.ALCHEMY_HOME;
afterEach(() => {
	if (priorHome === undefined) delete process.env.ALCHEMY_HOME;
	else process.env.ALCHEMY_HOME = priorHome;
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

type Denial =
	| "none"
	| "ownership"
	| "environment"
	| "plan"
	| "route"
	| "financial"
	| "revalidate";
function fixture(denial: Denial = "none") {
	const directory = mkdtempSync(join(tmpdir(), "hobo-host-callback-"));
	dirs.push(directory);
	process.env.ALCHEMY_HOME = join(directory, "home");
	const calls: string[] = [];
	let traps = 0;
	let effects = 0;
	/* oxlint-disable-next-line anti-slop/no-object-parameters -- SAFETY: the fixture decorates existing functions to probe mutable method properties. */
	const poison = (fn: object) => {
		for (const name of ["bind", "call"]) {
			Object.defineProperty(fn, name, {
				get() {
					traps++;
					return () => () => true;
				},
			});
		}
	};
	const ownership: AlchemyStateOwnership = {
		backendRef: "host:state",
		ownershipEpoch: "1",
		verify() {
			expect(this).toBe(ownership);
			calls.push("ownership");
			return denial !== "ownership";
		},
	};
	const composite: AlchemyCompositeGuard = {
		proofRef: "host:sandbox",
		environmentDigest: `sha256:${"b".repeat(64)}`,
		sourceRequirements: [],
		verifyEnvironment() {
			expect(this).toBe(composite);
			calls.push("environment");
			return denial !== "environment";
		},
		verifyPlan() {
			expect(this).toBe(composite);
			calls.push("plan");
			return denial !== "plan";
		},
	};
	const financial: FinancialPort<{ marker: string }> = {
		assess() {
			expect(this).toBe(financial);
			calls.push("assess");
			return { marker: "original" };
		},
		async admit(requestId) {
			expect(this).toBe(financial);
			calls.push("admit");
			if (denial === "financial")
				return {
					requestId,
					targetId: "target",
					status: "denied",
					code: "BUDGET_DENIED",
					message: "",
					budget: { evaluation: "denied", reservation: "not-created" },
				};
			return {
				requestId,
				targetId: "target",
				status: "admitted",
				code: "",
				message: "",
				budget: { evaluation: "allowed", reservation: "held" },
				reservation: {
					reservationId: `iac:${requestId}`,
					unboundedExposure: false,
				},
				requestDigest: `sha256:${"d".repeat(64)}`,
				inventoryHash: `sha256:${"c".repeat(64)}`,
				modelHash: `sha256:${"e".repeat(64)}`,
				quoteHash: `sha256:${"f".repeat(64)}`,
			};
		},
		revalidate() {
			expect(this).toBe(financial);
			calls.push("revalidate");
			return denial !== "revalidate";
		},
		uncertain() {
			expect(this).toBe(financial);
			calls.push("uncertain");
		},
	};
	const base = routeFixture();
	const route: IacRoutePort = {
		persistence: "durable-cas",
		verifyAttempt(permit) {
			expect(this).toBe(route);
			calls.push("route-verify");
			return base.port.verifyAttempt(permit);
		},
		consumeAttempt(permit) {
			expect(this).toBe(route);
			calls.push("route-consume");
			return denial === "route" ? false : base.port.consumeAttempt(permit);
		},
		runDirect(input, run) {
			expect(this).toBe(route);
			calls.push("route-direct");
			return base.port.runDirect(input, run);
		},
	};
	for (const fn of [
		ownership.verify,
		composite.verifyEnvironment,
		composite.verifyPlan,
		financial.assess,
		financial.admit,
		financial.revalidate,
		financial.uncertain,
		route.verifyAttempt,
		route.consumeAttempt,
		route.runDirect,
	])
		poison(fn);
	const stack = Stack(
		"App",
		{
			providers: Provider.succeed(Widget, {
				reconcile: () =>
					Effect.sync(() => {
						effects++;
						return { id: "widget" };
					}),
				delete: () => Effect.void,
			}),
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			yield* Widget("widget", {});
			return {};
		}),
	);
	const options = {
		stack,
		target: alchemyTarget({
			targetId: "target",
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
					providerId: "test",
					providerAccountRef: "account",
					productId: "widget",
				},
			],
		}),
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: directory,
		stateOwnership: ownership,
		composite,
		financial,
		route,
		resolveRoute: ({ requestId }: { requestId?: string | undefined }) => ({
			requestId: requestId ?? "request",
			operation: testOperation,
		}),
	};
	return {
		options,
		ownership,
		composite,
		financial,
		route,
		calls,
		traps: () => traps,
		effects: () => effects,
	};
}

describe("host authority callback capture", () => {
	it("keeps a receipt with inherited denial records uncertain", async () => {
		const f = fixture();
		f.financial.admit = async () => {
			f.calls.push("admit");
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: an empty receipt deliberately probes the financial-result boundary.
			return {} as never;
		};
		const provider = createAlchemyIacProvider(f.options);
		await provider.preview(program);
		const fields = {
			requestId: "request",
			targetId: "target",
			status: "denied",
			code: "BUDGET_DENIED",
			message: "denied",
			budget: { evaluation: "denied", reservation: "not-created" },
		};
		const previous = Object.entries(fields).map(
			([key]) =>
				[key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const,
		);
		for (const [key, value] of Object.entries(fields))
			Object.defineProperty(Object.prototype, key, {
				configurable: true,
				writable: true,
				value: { value, enumerable: true },
			});
		let error: unknown;
		try {
			await provider.applyWithAdmission(program, "request");
		} catch (caught) {
			error = caught;
		} finally {
			for (const [key, old] of previous) {
				if (old === undefined) Reflect.deleteProperty(Object.prototype, key);
				else Object.defineProperty(Object.prototype, key, old);
			}
		}
		expect(error).toMatchObject({ code: "ADMISSION_RECEIPT_INVALID" });
		expect(f.calls).toContain("admit");
		expect(f.effects()).toBe(0);
	});

	it("rejects a route permit whose missing fields are inherited descriptor records", async () => {
		const f = fixture("financial");
		const provider = createAlchemyIacProvider(f.options);
		await provider.preview(program);
		const fields = {
			tenantId: "tenant",
			requestId: "request",
			targetId: "target",
			operationId: testOperation.operationId,
			inventoryHash: `sha256:${"c".repeat(64)}`,
			attemptId: "a".repeat(43),
		};
		const previous = Object.entries(fields).map(
			([key]) =>
				[key, Object.getOwnPropertyDescriptor(Object.prototype, key)] as const,
		);
		for (const [key, value] of Object.entries(fields))
			Object.defineProperty(Object.prototype, key, {
				configurable: true,
				writable: true,
				value: { value, enumerable: true },
			});
		let error: unknown;
		try {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the empty permit deliberately probes inherited descriptor maps.
			await provider.applyWithAdmission(
				program,
				"request",
				undefined,
				{} as never,
			);
		} catch (caught) {
			error = caught;
		} finally {
			for (const [key, old] of previous) {
				if (old === undefined) Reflect.deleteProperty(Object.prototype, key);
				else Object.defineProperty(Object.prototype, key, old);
			}
		}
		expect(error).toMatchObject({ code: "ROUTE_PERMIT_UNVERIFIED" });
		expect(f.calls).not.toContain("route-consume");
		expect(f.calls).not.toContain("admit");
		expect(f.effects()).toBe(0);
	});

	it("keeps its original proxy predicate for host capabilities", () => {
		const f = fixture();
		let traps = 0;
		const financial = new Proxy(f.financial, {
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("descriptor");
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
			createAlchemyIacProvider({ ...f.options, financial });
		} catch (caught) {
			error = caught;
		} finally {
			if (previous !== undefined)
				Object.defineProperty(types, "isProxy", previous);
		}
		expect(error).toMatchObject({ code: "FINANCIAL_AUTHORITY_UNAVAILABLE" });
		expect(traps).toBe(0);
	});

	it("rejects an accessor even when Object.prototype supplies a value getter", () => {
		const f = fixture();
		let traps = 0;
		Object.defineProperty(f.financial, "revalidate", {
			enumerable: true,
			get() {
				traps++;
				throw new Error("host accessor");
			},
		});
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get() {
				traps++;
				throw new Error("inherited descriptor value");
			},
		});
		let error: unknown;
		try {
			createAlchemyIacProvider(f.options);
		} catch (caught) {
			error = caught;
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(Object.prototype, "value");
			else Object.defineProperty(Object.prototype, "value", previous);
		}
		expect(error).toMatchObject({ code: "FINANCIAL_AUTHORITY_UNAVAILABLE" });
		expect(traps).toBe(0);
		expect(f.effects()).toBe(0);
	});

	it("calls the original functions with their original receiver, never mutable bind/call properties", async () => {
		const f = fixture();
		const provider = createAlchemyIacProvider(f.options);
		expect(await provider.assessPricing(program)).toMatchObject({
			marker: "original",
		});
		await provider.applyWithAdmission(program, "request");
		expect(f.effects()).toBe(1);
		expect(f.traps()).toBe(0);
		for (const name of [
			"ownership",
			"environment",
			"plan",
			"assess",
			"route-direct",
			"route-verify",
			"route-consume",
			"admit",
			"revalidate",
		])
			expect(f.calls).toContain(name);
	});
	it.each([
		["ownership", "STATE_SCOPE_UNVERIFIED"],
		["environment", "COMPOSITE_ENVIRONMENT_UNVERIFIED"],
		["plan", "COMPOSITE_PLAN_UNVERIFIED"],
	] as const)("cannot substitute an approving %s verifier", async (denial, code) => {
		const f = fixture(denial);
		await expect(
			createAlchemyIacProvider(f.options).preview(program),
		).rejects.toMatchObject({ code });
		expect(f.traps()).toBe(0);
		expect(f.effects()).toBe(0);
	});
	it.each([
		["route", "ROUTE_PERMIT_UNVERIFIED"],
		["financial", "BUDGET_DENIED"],
		["revalidate", "ADMISSION_REVALIDATION_FAILED"],
	] as const)("cannot substitute a successful %s action", async (denial, code) => {
		const f = fixture(denial);
		const provider = createAlchemyIacProvider(f.options);
		await provider.preview(program);
		await expect(
			provider.applyWithAdmission(program, "request"),
		).rejects.toMatchObject({ code });
		if (denial === "revalidate") expect(f.calls).toContain("uncertain");
		expect(f.traps()).toBe(0);
		expect(f.effects()).toBe(0);
	});
	it.each([
		["stateOwnership", "verify", "STATE_SCOPE_UNVERIFIED"],
		["composite", "verifyEnvironment", "COMPOSITE_ENVIRONMENT_UNVERIFIED"],
		["composite", "verifyPlan", "COMPOSITE_ENVIRONMENT_UNVERIFIED"],
		["financial", "admit", "FINANCIAL_AUTHORITY_UNAVAILABLE"],
		["financial", "assess", "FINANCIAL_AUTHORITY_UNAVAILABLE"],
		["financial", "revalidate", "FINANCIAL_AUTHORITY_UNAVAILABLE"],
		["financial", "uncertain", "FINANCIAL_AUTHORITY_UNAVAILABLE"],
		["route", "runDirect", "ROUTE_AUTHORITY_UNAVAILABLE"],
		["route", "verifyAttempt", "ROUTE_AUTHORITY_UNAVAILABLE"],
		["route", "consumeAttempt", "ROUTE_AUTHORITY_UNAVAILABLE"],
	] as const)("rejects proxied or accessor-backed %s.%s without executing a trap", (section, key, code) => {
		for (const mode of ["container", "callback", "accessor"] as const) {
			const f = fixture();
			let traps = 0;
			const original = f.options[section];
			const callbacks = { ...original };
			if (mode === "callback") {
				Object.defineProperty(callbacks, key, {
					value: new Proxy(() => true, {
						apply() {
							traps++;
							throw new Error("trap");
						},
					}),
					enumerable: true,
				});
			} else if (mode === "accessor") {
				Object.defineProperty(callbacks, key, {
					get() {
						traps++;
						throw new Error("trap");
					},
					enumerable: true,
				});
			}
			const bad =
				mode === "container"
					? new Proxy(callbacks, {
							get() {
								traps++;
								throw new Error("trap");
							},
							getOwnPropertyDescriptor() {
								traps++;
								throw new Error("trap");
							},
						})
					: callbacks;
			expect(() =>
				createAlchemyIacProvider({ ...f.options, [section]: bad }),
			).toThrow(code);
			expect(traps).toBe(0);
			expect(f.effects()).toBe(0);
		}
	});
	it("rejects proxied source requirements, source fences, and source verifier functions before traps", () => {
		let traps = 0;
		const wrap = <T extends object>(value: T): T =>
			new Proxy(value, {
				get() {
					traps++;
					throw new Error("trap");
				},
				ownKeys() {
					traps++;
					throw new Error("trap");
				},
				getPrototypeOf() {
					traps++;
					throw new Error("trap");
				},
			});
		const fence = {
			sourceDigest: `sha256:${"a".repeat(64)}`,
			environmentDigest: `sha256:${"b".repeat(64)}`,
			proofRef: "host",
			verify: () => true,
		};
		expect(captureAlchemySourceFence(wrap(fence))).toBeUndefined();
		expect(
			captureAlchemySourceFence({ ...fence, verify: wrap(fence.verify) }),
		).toBeUndefined();
		expect(captureAlchemySourceRequirements(wrap([]))).toBeUndefined();
		const requirement = {
			resourceId: "widget",
			resourceType: "Spec.Widget",
			bindleName: "app",
			applicationName: "app",
			sourceKind: "test",
			sourcePath: "/app",
		};
		expect(
			captureAlchemySourceRequirements([wrap(requirement)]),
		).toBeUndefined();
		expect(traps).toBe(0);
	});
	it("rejects a proxied operation resolver before its apply trap", () => {
		const f = fixture();
		let traps = 0;
		const resolveRoute = new Proxy(f.options.resolveRoute, {
			apply() {
				traps++;
				throw new Error("trap");
			},
		});
		expect(() =>
			createAlchemyIacProvider({ ...f.options, resolveRoute }),
		).toThrow("ROUTE_OPERATION_UNVERIFIED");
		expect(traps).toBe(0);
		expect(f.effects()).toBe(0);
	});
});
