/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these malformed inputs exercise the JavaScript boundary. */
import { types as utilTypes } from "node:util";
import { expect, it } from "vitest";
import { createIacFinancialServices } from "../src/iac-financial-services.js";
import { admitIacTarget } from "../src/iac-target.js";
import { admitUnpricedIacTarget } from "../src/iac-unpriced.js";

it("rejects proxied admission and host inputs after the proxy predicate is replaced", async () => {
	let traps = 0;
	let calls = 0;
	const original = Object.getOwnPropertyDescriptor(utilTypes, "isProxy");
	const input = new Proxy(
		{},
		{
			getPrototypeOf() {
				traps++;
				throw new Error("proxy trap");
			},
			ownKeys() {
				traps++;
				throw new Error("proxy trap");
			},
			getOwnPropertyDescriptor() {
				traps++;
				throw new Error("proxy trap");
			},
		},
	);
	const deps = {
		get authority() {
			calls++;
			throw new Error("authority called");
		},
	};
	let priced: Promise<unknown>;
	let unpriced: Promise<unknown>;
	let refused = false;
	try {
		Object.defineProperty(utilTypes, "isProxy", {
			configurable: true,
			value: () => false,
		});
		priced = admitIacTarget(input as never, deps as never);
		unpriced = admitUnpricedIacTarget(input as never, deps as never);
		try {
			createIacFinancialServices(input as never);
		} catch {
			refused = true;
		}
	} finally {
		if (original) Object.defineProperty(utilTypes, "isProxy", original);
	}
	expect(await priced).toMatchObject({
		status: "denied",
		budget: { reservation: "not-created" },
	});
	expect(await unpriced).toMatchObject({
		status: "denied",
		budget: { reservation: "not-created" },
	});
	expect(refused).toBe(true);
	expect(traps).toBe(0);
	expect(calls).toBe(0);
});

it.each([
	"priced",
	"unpriced",
] as const)("refuses accessor-backed %s request fields without inherited descriptor traps", async (kind) => {
	let traps = 0;
	let authorityCalls = 0;
	const originalValue = Object.getOwnPropertyDescriptor(
		Object.prototype,
		"value",
	);
	const deps = {
		get authority() {
			authorityCalls++;
			throw new Error("authority");
		},
	};
	for (const key of kind === "priced"
		? ["requestId", "inventory", "pricing", "evidence"]
		: ["requestId", "inventory", "pricing"]) {
		const input = { requestId: "request", inventory: {}, pricing: {} };
		Object.defineProperty(input, key, {
			enumerable: true,
			get() {
				traps++;
				throw new Error("input getter");
			},
		});
		let pending: Promise<unknown>;
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					traps++;
					throw new Error("descriptor getter");
				},
			});
			pending =
				kind === "priced"
					? admitIacTarget(input as never, deps as never)
					: admitUnpricedIacTarget(input as never, deps as never);
		} finally {
			Reflect.deleteProperty(Object.prototype, "value");
			if (originalValue)
				Object.defineProperty(Object.prototype, "value", originalValue);
		}
		expect(await pending).toMatchObject({
			status: "denied",
			budget: { reservation: "not-created" },
		});
	}
	expect(traps).toBe(0);
	expect(authorityCalls).toBe(0);
});

it("refuses an accessor target identity without inherited descriptor traps", async () => {
	let traps = 0;
	const originalValue = Object.getOwnPropertyDescriptor(
		Object.prototype,
		"value",
	);
	const inventory = Object.defineProperty({}, "targetId", {
		enumerable: true,
		get() {
			traps++;
			throw new Error("input getter");
		},
	});
	let pending: Promise<unknown>;
	try {
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get() {
				traps++;
				throw new Error("descriptor getter");
			},
		});
		pending = admitIacTarget(
			{ requestId: "", inventory, pricing: {} } as never,
			{} as never,
		);
	} finally {
		Reflect.deleteProperty(Object.prototype, "value");
		if (originalValue)
			Object.defineProperty(Object.prototype, "value", originalValue);
	}
	expect(await pending).toMatchObject({
		status: "denied",
		code: "REQUEST_INVALID",
	});
	expect(traps).toBe(0);
});

it("refuses accessor-backed financial host fields without inherited descriptor traps", () => {
	let traps = 0;
	const originalValue = Object.getOwnPropertyDescriptor(
		Object.prototype,
		"value",
	);
	const makeOptions = () => ({
		authority: {},
		now: () => "",
		verifyLiability: () => false,
		authorize: () => false,
		issueLiability: () => false,
	});
	for (const key of [
		"authority",
		"now",
		"verifyLiability",
		"authorize",
		"issueLiability",
		"pricing",
		"unpriced",
	]) {
		const options = makeOptions();
		Object.defineProperty(options, key, {
			enumerable: true,
			get() {
				traps++;
				throw new Error("input getter");
			},
		});
		let refused = false;
		try {
			Object.defineProperty(Object.prototype, "value", {
				configurable: true,
				get() {
					traps++;
					throw new Error("descriptor getter");
				},
			});
			try {
				createIacFinancialServices(options as never);
			} catch {
				refused = true;
			}
		} finally {
			Reflect.deleteProperty(Object.prototype, "value");
			if (originalValue)
				Object.defineProperty(Object.prototype, "value", originalValue);
		}
		expect(refused).toBe(true);
	}
	const nested = Object.defineProperty({}, "authorize", {
		enumerable: true,
		get() {
			traps++;
			throw new Error("input getter");
		},
	});
	let refused = false;
	try {
		Object.defineProperty(Object.prototype, "value", {
			configurable: true,
			get() {
				traps++;
				throw new Error("descriptor getter");
			},
		});
		try {
			createIacFinancialServices({
				...makeOptions(),
				unpriced: nested,
			} as never);
		} catch {
			refused = true;
		}
	} finally {
		Reflect.deleteProperty(Object.prototype, "value");
		if (originalValue)
			Object.defineProperty(Object.prototype, "value", originalValue);
	}
	expect(refused).toBe(true);
	expect(traps).toBe(0);
});
