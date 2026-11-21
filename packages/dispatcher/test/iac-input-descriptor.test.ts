/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unsafe-dictionary-type -- SAFETY: malformed inputs intentionally exercise the public boundary. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types as utilTypes } from "node:util";
import { expect, it } from "vitest";
import { runIacRoute } from "../src/iac-route.js";
import { createSqliteIacRouteAuthority } from "../src/iac-route-sqlite.js";
import {
	executeRankedIacTargets,
	rankIacTargets,
} from "../src/iac-target-routing.js";
import {
	isBoundedRouteValue,
	ownDataField,
	ownDataFields,
	uninspectable,
} from "../src/iac-untrusted.js";

it("refuses proxied route inputs and callbacks after the proxy predicate is replaced", async () => {
	let traps = 0;
	let calls = 0;
	const original = Object.getOwnPropertyDescriptor(utilTypes, "isProxy");
	const proxied = new Proxy(
		{},
		{
			getPrototypeOf() {
				traps++;
				throw new Error("proxy trap");
			},
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("proxy trap");
			},
		},
	);
	const callback = new Proxy(
		async () => ({ value: {}, outcome: { status: "denied" as const } }),
		{
			apply() {
				traps++;
				throw new Error("callback trap");
			},
		},
	);
	const authority = {
		claim() {
			calls++;
			throw new Error("authority called");
		},
	};
	let field: unknown;
	let bounded = true;
	let refused = false;
	let pending: ReturnType<typeof runIacRoute>;
	try {
		Object.defineProperty(utilTypes, "isProxy", {
			configurable: true,
			value: () => false,
		});
		field = ownDataField(proxied, "tenantId");
		bounded = isBoundedRouteValue(proxied);
		try {
			createSqliteIacRouteAuthority(proxied as never);
		} catch {
			refused = true;
		}
		pending = runIacRoute({
			authority: authority as never,
			tenantId: "tenant",
			requestId: "request",
			operation: {} as never,
			run: callback,
		});
	} finally {
		if (original) Object.defineProperty(utilTypes, "isProxy", original);
	}
	expect(field).toBe(uninspectable);
	expect(bounded).toBe(false);
	expect(refused).toBe(true);
	expect(await pending).toMatchObject({
		status: "uncertain",
		code: "ROUTE_INPUT_UNINSPECTABLE",
	});
	expect(traps).toBe(0);
	expect(calls).toBe(0);
});

it("checks signed BigInt bounds without invoking conversion", () => {
	const max = 10n ** 128n - 1n;
	const min = 1n - 10n ** 127n;
	const original = BigInt.prototype.toString;
	let traps = 0;
	let results: boolean[] = [];
	try {
		BigInt.prototype.toString = () => {
			traps++;
			throw new Error("conversion trap");
		};
		results = [0n, max, max + 1n, min, min - 1n].map(isBoundedRouteValue);
	} finally {
		BigInt.prototype.toString = original;
	}
	expect(results).toEqual([true, true, false, true, false]);
	expect(traps).toBe(0);
});

it("refuses accessors without reading inherited descriptor values or setters", () => {
	let traps = 0;
	const input = Object.defineProperty({}, "field", {
		enumerable: true,
		get() {
			traps++;
			throw new Error("input getter");
		},
	});
	const originalValue = Object.getOwnPropertyDescriptor(
		Object.prototype,
		"value",
	);
	const originalTenant = Object.getOwnPropertyDescriptor(
		Object.prototype,
		"tenantId",
	);
	let field: unknown;
	let bounded = true;
	let fields: Record<string, unknown> | undefined;
	try {
		Object.defineProperty(Object.prototype, "tenantId", {
			configurable: true,
			set() {
				traps++;
				throw new Error("setter");
			},
		});
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get() {
				traps++;
				throw new Error("descriptor getter");
			},
		});
		field = ownDataField(input, "field");
		bounded = isBoundedRouteValue(input);
		fields = ownDataFields({ tenantId: "tenant" }, ["tenantId"]);
	} finally {
		Reflect.deleteProperty(Object.prototype, "value");
		Reflect.deleteProperty(Object.prototype, "tenantId");
		if (originalValue)
			Object.defineProperty(Object.prototype, "value", originalValue);
		if (originalTenant)
			Object.defineProperty(Object.prototype, "tenantId", originalTenant);
	}
	expect(field).toBe(uninspectable);
	expect(bounded).toBe(false);
	expect(fields?.tenantId).toBe("tenant");
	expect(traps).toBe(0);
});

it("keeps pricing ranking and route execution closed under descriptor pollution", async () => {
	let traps = 0;
	let calls = 0;
	const rank = {
		tenantId: "tenant",
		workloadRef: "workload",
		action: "deploy",
		at: "2026-01-01T00:00:00Z",
		horizon: "2026-02-01T00:00:00Z",
		candidates: [],
	};
	Object.defineProperty(rank, "tenantId", {
		enumerable: true,
		get() {
			traps++;
			throw new Error("input getter");
		},
	});
	const execution = {
		authority: {
			claim() {
				calls++;
				throw new Error("authority");
			},
		},
		tenantId: "tenant",
		requestId: "request",
		operation: {},
		ranking: {},
		candidates: [],
	};
	Object.defineProperty(execution, "tenantId", {
		enumerable: true,
		get() {
			traps++;
			throw new Error("input getter");
		},
	});
	const originalValue = Object.getOwnPropertyDescriptor(
		Object.prototype,
		"value",
	);
	let result: ReturnType<typeof rankIacTargets>;
	let pending: ReturnType<typeof executeRankedIacTargets>;
	try {
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get() {
				traps++;
				throw new Error("descriptor getter");
			},
		});
		result = rankIacTargets(rank as never);
		pending = executeRankedIacTargets(execution as never);
	} finally {
		Reflect.deleteProperty(Object.prototype, "value");
		if (originalValue)
			Object.defineProperty(Object.prototype, "value", originalValue);
	}
	expect(result).toMatchObject({
		code: "ROUTING_INPUT_INVALID",
		budget: { evaluation: "not-evaluated", reservation: "not-created" },
	});
	expect(await pending).toMatchObject({
		status: "uncertain",
		code: "ROUTING_INPUT_UNINSPECTABLE",
	});
	expect(traps).toBe(0);
	expect(calls).toBe(0);
});

it.each([
	"candidate",
	"target",
] as const)("rejects an accessor-backed %s during pricing ranking", (kind) => {
	let traps = 0;
	const trap = () => {
		traps++;
		throw new Error("input getter");
	};
	const inventory = { targetId: "target" };
	const candidate = { workloadRef: "workload", inventory, pricing: {} };
	const candidates = [candidate];
	if (kind === "candidate")
		Object.defineProperty(candidates, "0", { enumerable: true, get: trap });
	else
		Object.defineProperty(inventory, "targetId", {
			enumerable: true,
			get: trap,
		});
	const rank = {
		tenantId: "tenant",
		workloadRef: "workload",
		action: "deploy",
		at: "2026-01-01T00:00:00Z",
		horizon: "2026-02-01T00:00:00Z",
		candidates,
	};
	const originalValue = Object.getOwnPropertyDescriptor(
		Object.prototype,
		"value",
	);
	let result: ReturnType<typeof rankIacTargets>;
	try {
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get: trap,
		});
		result = rankIacTargets(rank as never);
	} finally {
		Reflect.deleteProperty(Object.prototype, "value");
		if (originalValue)
			Object.defineProperty(Object.prototype, "value", originalValue);
	}
	expect(result).toMatchObject({
		code: "ROUTING_INPUT_INVALID",
		budget: { evaluation: "not-evaluated", reservation: "not-created" },
	});
	expect(traps).toBe(0);
});

it("rejects proxied and accessor-backed SQLite authority inputs before traps or authentication", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-route-boundary-"));
	let traps = 0;
	let checks = 0;
	const path = join(directory, "route.sqlite");
	const options = {
		path,
		verifyOperation: () => {
			checks++;
			return true;
		},
	};
	const proxyOptions = new Proxy(options, {
		get() {
			traps++;
			throw new Error("trap");
		},
		getOwnPropertyDescriptor() {
			traps++;
			throw new Error("trap");
		},
	});
	try {
		expect(() => createSqliteIacRouteAuthority(proxyOptions)).toThrow();
		const badOptions = Object.defineProperty(
			{ ...options },
			"verifyOperation",
			{
				enumerable: true,
				get() {
					traps++;
					throw new Error("input getter");
				},
			},
		);
		const priorValue = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"value",
		);
		let rejected = false;
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					traps++;
					throw new Error("descriptor getter");
				},
			});
			try {
				createSqliteIacRouteAuthority(badOptions);
			} catch {
				rejected = true;
			}
		} finally {
			Reflect.deleteProperty(Object.prototype, "value");
			if (priorValue)
				Object.defineProperty(Object.prototype, "value", priorValue);
		}
		expect(rejected).toBe(true);
		const authority = createSqliteIacRouteAuthority(options);
		try {
			const identity = {
				tenantId: "tenant",
				requestId: "request",
				operationId: `sha256:${"a".repeat(64)}`,
				authorization: "proof",
			};
			const proxied = new Proxy(identity, {
				get() {
					traps++;
					throw new Error("trap");
				},
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("trap");
				},
			});
			await expect(authority.claim(proxied)).rejects.toThrow();
			expect(() => authority.inspect(proxied)).toThrow();
			expect(authority.verifyAttempt(proxied as never)).toBe(false);
			const invalid = Object.defineProperty({ ...identity }, "tenantId", {
				enumerable: true,
				get() {
					traps++;
					throw new Error("input getter");
				},
			});
			const originalValue = Object.getOwnPropertyDescriptor(
				Object.prototype,
				"value",
			);
			let pending: Promise<unknown>;
			try {
				Object.defineProperty(Object.prototype, "value", {
					configurable: true,
					get() {
						traps++;
						throw new Error("descriptor getter");
					},
				});
				pending = Promise.resolve(authority.claim(invalid));
			} finally {
				Reflect.deleteProperty(Object.prototype, "value");
				if (originalValue)
					Object.defineProperty(Object.prototype, "value", originalValue);
			}
			await expect(pending).rejects.toThrow();
			expect(traps).toBe(0);
			expect(checks).toBe(0);
		} finally {
			authority.close();
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
