/* oxlint-disable anti-slop/no-reflect-apply, anti-slop/no-runtime-typeof, unicorn/no-thenable -- SAFETY: the fixtures exercise hostile thenables and timer setup failure. */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import {
	createRivetHttpAuthorizationGate,
	rivetHttpAuthorizationCurrent,
} from "../src/rivet-http-authorization.js";

it.each([
	"setup-failure",
	"early-fire",
] as const)("does not invoke a queued authorizer after timer %s", async (mode) => {
	const decide = vi.fn(() => true);
	const original = globalThis.setTimeout;
	let pending: ReturnType<ReturnType<typeof createRivetHttpAuthorizationGate>>;
	try {
		globalThis.setTimeout = new Proxy(original, {
			apply(target, receiver, args) {
				if (mode === "setup-failure") throw new Error("timer unavailable");
				const timer = Reflect.apply(target, receiver, args);
				const callback = args[0];
				if (typeof callback !== "function") throw new Error("missing callback");
				Reflect.apply(callback, undefined, []);
				return timer;
			},
		});
		const gate = createRivetHttpAuthorizationGate(1_000);
		pending = gate(decide);
	} finally {
		globalThis.setTimeout = original;
	}
	const result = (await pending).value;
	for (let index = 0; index < 5; index++) await Promise.resolve();
	expect(result.status).toBe("unavailable");
	expect(decide).not.toHaveBeenCalled();
	expect(rivetHttpAuthorizationCurrent(result)).toBe(false);
	const healthy = createRivetHttpAuthorizationGate(1_000);
	expect((await healthy(() => true)).value.status).toBe("allow");
});

it("uses captured timer cleanup after an authorizer replaces the global function", async () => {
	const gate = createRivetHttpAuthorizationGate(1_000);
	const original = globalThis.clearTimeout;
	let traps = 0;
	try {
		const result = (
			await gate(() => {
				globalThis.clearTimeout = new Proxy(original, {
					apply() {
						traps++;
						throw new Error("timer cleanup unavailable");
					},
				});
				return true;
			})
		).value;
		expect(result.status).toBe("allow");
		expect(rivetHttpAuthorizationCurrent(result)).toBe(true);
	} finally {
		globalThis.clearTimeout = original;
	}
	expect(traps).toBe(0);
});

it("does not start authorization after a synchronous scope check exhausts the deadline", async () => {
	const gate = createRivetHttpAuthorizationGate(10);
	let scopeChecks = 0;
	let authorizations = 0;
	const result = await gate((current) => {
		scopeChecks++;
		const start = performance.now();
		while (performance.now() - start < 25) {}
		if (!current()) throw undefined;
		authorizations++;
		return true;
	});
	expect(result.value.status).toBe("unavailable");
	expect(scopeChecks).toBe(1);
	expect(authorizations).toBe(0);
});

it("keeps timed-out decisions in the capacity limit until their native promises settle", async () => {
	const gate = createRivetHttpAuthorizationGate(250);
	const releases: Array<(allowed: boolean) => void> = [];
	let calls = 0;
	const decide = () => {
		calls++;
		return new Promise<boolean>((resolve) => releases.push(resolve));
	};
	const attempts = Array.from({ length: 128 }, () => gate(decide));
	const decisions = await Promise.all(attempts);
	expect(calls).toBe(128);
	expect(decisions.every(({ value }) => value.status === "unavailable")).toBe(
		true,
	);
	expect((await gate(decide)).value.status).toBe("unavailable");
	expect(calls).toBe(128);

	releases[0]?.(false);
	await new Promise<void>((resolve) => setImmediate(resolve));
	const replacement = gate(decide);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(calls).toBe(129);
	expect((await gate(decide)).value.status).toBe("unavailable");
	expect(calls).toBe(129);
	for (const release of releases) release(false);
	expect((await replacement).value.status).toBe("deny");
});

it("refuses malformed and proxied results without invoking then or proxy traps", async () => {
	let traps = 0;
	const thenable = {
		// biome-ignore lint/suspicious/noThenProperty: this is the untrusted thenable under test.
		get then() {
			traps++;
			throw new Error("unexpected then lookup");
		},
	};
	const proxy = new Proxy(Promise.resolve(true), {
		get() {
			traps++;
			throw new Error("unexpected proxy lookup");
		},
		getPrototypeOf() {
			traps++;
			throw new Error("unexpected proxy reflection");
		},
	});
	class OtherPromise<T> extends Promise<T> {}
	const malformed = [thenable, proxy, OtherPromise.resolve(true), {}, "yes"];
	for (const result of malformed) {
		const gate = createRivetHttpAuthorizationGate(1_000);
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: each deliberately malformed result exercises the runtime boundary.
		expect((await gate(() => result as never)).value.status).toBe(
			"unavailable",
		);
	}
	expect(traps).toBe(0);
});

it("quarantines uninspectable results rather than releasing their slots", async () => {
	const gate = createRivetHttpAuthorizationGate(1_000);
	let calls = 0;
	let traps = 0;
	const result = new Proxy(
		{},
		{
			get() {
				traps++;
				throw new Error("unexpected proxy lookup");
			},
		},
	);
	const decide = () => {
		calls++;
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this proxy deliberately violates the JavaScript authority contract.
		return result as never;
	};
	const attempts = Array.from({ length: 128 }, () => gate(decide));
	expect(
		(await Promise.all(attempts)).every(
			({ value }) => value.status === "unavailable",
		),
	).toBe(true);
	expect((await gate(decide)).value.status).toBe("unavailable");
	expect(calls).toBe(128);
	expect(traps).toBe(0);
});

it("observes an ordinary rejected promise without inspecting its rejection", async () => {
	let traps = 0;
	const rejection = new Proxy(
		{},
		{
			get() {
				traps++;
				throw new Error("unexpected rejection lookup");
			},
			getPrototypeOf() {
				traps++;
				throw new Error("unexpected rejection reflection");
			},
		},
	);
	const gate = createRivetHttpAuthorizationGate(1_000);
	expect((await gate(() => Promise.reject(rejection))).value.status).toBe(
		"unavailable",
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(traps).toBe(0);
});

it("keeps an authorizer from forging permission by replacing promise and timer intrinsics", () => {
	const loader = createRequire(import.meta.url).resolve("tsx");
	const fixture = fileURLToPath(
		new URL("./rivet-http-authorization-fixture.mts", import.meta.url),
	);
	const output = execFileSync(process.execPath, ["--import", loader, fixture], {
		encoding: "utf8",
		timeout: 5_000,
	});
	expect(output).toContain("http-authorization-intrinsics-ok");
});
