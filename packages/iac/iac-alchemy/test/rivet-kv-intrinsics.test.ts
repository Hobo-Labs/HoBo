// biome-ignore-all lint/suspicious/noThenProperty: Hostile thenable getters are deliberate boundary test inputs.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import {
	boundedRivetKvDecision,
	rivetKvDeadline,
	rivetKvNative,
} from "../src/rivet-kv-boundary.js";
import {
	kvActorKey,
	kvActorName,
	kvBytes,
	kvDecode,
	kvDigest,
	kvFingerprint,
	kvKey,
} from "../src/rivet-kv-protocol.js";

vi.hoisted(() => vi.resetModules());

it("retains every actor-key component when the global String constructor changes", () => {
	const input = ["tenant", "settings"];
	const NativeString = globalThis.String;
	let result: ReturnType<typeof kvActorKey>;
	try {
		Reflect.set(globalThis, "String", (value: number) =>
			value === 1 ? "0" : NativeString(value),
		);
		result = kvActorKey(input);
	} finally {
		Reflect.set(globalThis, "String", NativeString);
	}
	expect(result).toEqual(input);
	expect(Object.getOwnPropertyDescriptor(result, "1")).toMatchObject({
		value: "settings",
		enumerable: true,
	});
});

it("copies actor keys as dense own data without invoking inherited numeric setters", () => {
	const input = ["tenant", "settings"];
	const previous = Object.getOwnPropertyDescriptor(Array.prototype, "0");
	let setterCalls = 0;
	let result: ReturnType<typeof kvActorKey>;
	try {
		Object.defineProperty(Array.prototype, "0", {
			configurable: true,
			set() {
				setterCalls++;
			},
		});
		result = kvActorKey(input);
	} finally {
		if (previous) Object.defineProperty(Array.prototype, "0", previous);
		else Reflect.deleteProperty(Array.prototype, "0");
	}
	expect(setterCalls).toBe(0);
	expect(result).toEqual(input);
	expect(Object.getOwnPropertyDescriptor(result, "0")).toMatchObject({
		value: "tenant",
		enumerable: true,
	});
});

it("rejects invalid actor identities when trim and RegExp exec are substituted", () => {
	const trim = String.prototype.trim;
	const exec = RegExp.prototype.exec;
	let validName = true;
	let validDigest = true;
	try {
		Reflect.set(String.prototype, "trim", function (this: string) {
			return String(this);
		});
		Reflect.set(RegExp.prototype, "exec", () => []);
		validName = kvActorName(" tenant ");
		validDigest = kvDigest("sha256:bad");
	} finally {
		Reflect.set(String.prototype, "trim", trim);
		Reflect.set(RegExp.prototype, "exec", exec);
	}
	expect(validName).toBe(false);
	expect(validDigest).toBe(false);
});

it("restores the exact own Promise constructor descriptor after attaching the observer", async () => {
	let finish: (value: number) => void = () => {};
	const pending = new Promise<number>((resolve) => {
		finish = resolve;
	});
	Object.defineProperty(pending, "constructor", {
		value: Promise,
		writable: true,
		enumerable: true,
		configurable: true,
	});
	const original = Object.getOwnPropertyDescriptor(pending, "constructor");
	const observed = rivetKvNative(pending);
	expect(Object.getOwnPropertyDescriptor(pending, "constructor")).toEqual(
		original,
	);
	finish(7);
	const box = await observed;
	expect(box.value).toBe(7);
	expect(Object.getPrototypeOf(box)).toBeNull();
	expect(Object.isFrozen(box)).toBe(true);
});

it("does not add an own constructor to a host Promise", async () => {
	const pending = Promise.resolve(11);
	const observed = rivetKvNative(pending);
	expect(Object.hasOwn(pending, "constructor")).toBe(false);
	expect((await observed).value).toBe(11);
	expect(Object.hasOwn(pending, "constructor")).toBe(false);
});

it("keeps object and Response values boxed under promise species and then poisoning", () => {
	const script = fileURLToPath(
		new URL("./rivet-kv-promise-poison.mjs", import.meta.url),
	);
	const loader = fileURLToPath(
		new URL("./rivet-kv-native-loader.mjs", import.meta.url),
	);
	const result = spawnSync(
		process.execPath,
		[
			"--no-warnings",
			"--experimental-transform-types",
			"--import",
			loader,
			script,
		],
		{
			encoding: "utf8",
			timeout: 5000,
			maxBuffer: 65_536,
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
});

it("preserves actual SQLite actor set and get results when Object.prototype.then is poisoned", () => {
	const script = fileURLToPath(
		new URL("./rivet-kv-actor-poison.mjs", import.meta.url),
	);
	const loader = fileURLToPath(
		new URL("./rivet-kv-native-loader.mjs", import.meta.url),
	);
	const result = spawnSync(
		process.execPath,
		[
			"--no-warnings",
			"--experimental-transform-types",
			"--import",
			loader,
			script,
		],
		{
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 65_536,
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
});

it("retains all client slots when cancellation is unknown and the global Promise is forged", () => {
	const script = fileURLToPath(
		new URL("./rivet-kv-retirement-poison.mjs", import.meta.url),
	);
	const result = spawnSync(
		process.execPath,
		["--no-warnings", "--import", "tsx", script],
		{
			encoding: "utf8",
			timeout: 10_000,
			maxBuffer: 65_536,
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.stderr).toBe("");
	expect(result.status).toBe(0);
});

it("keeps a later authority decision fail-closed after callback substitution of timers, listeners and promise methods", async () => {
	const controller = new AbortController();
	const deadline = rivetKvDeadline(controller.signal);
	const originalRace = Promise.race;
	const originalResolve = Promise.resolve;
	const originalTimer = globalThis.setTimeout;
	const originalAdd = EventTarget.prototype.addEventListener;
	const originalRemove = EventTarget.prototype.removeEventListener;
	let traps = 0;
	let calls = 0;
	let firstResult: boolean | undefined;
	let secondResult: boolean | undefined;
	const poison = () => {
		traps++;
		throw new Error("replaced intrinsic");
	};
	try {
		const first = boundedRivetKvDecision(
			() => {
				calls++;
				Object.defineProperty(Promise, "race", {
					value: poison,
					configurable: true,
					writable: true,
				});
				Object.defineProperty(Promise, "resolve", {
					value: poison,
					configurable: true,
					writable: true,
				});
				Object.defineProperty(globalThis, "setTimeout", {
					value: poison,
					configurable: true,
					writable: true,
				});
				Object.defineProperty(EventTarget.prototype, "addEventListener", {
					value: poison,
					configurable: true,
					writable: true,
				});
				Object.defineProperty(EventTarget.prototype, "removeEventListener", {
					value: poison,
					configurable: true,
					writable: true,
				});
				return false;
			},
			controller.signal,
			deadline,
			(pending) => pending,
		);
		firstResult = (await rivetKvNative(first)).value;
		const second = boundedRivetKvDecision(
			() => {
				calls++;
				return false;
			},
			controller.signal,
			deadline,
			(pending) => pending,
		);
		secondResult = (await rivetKvNative(second)).value;
	} finally {
		Promise.race = originalRace;
		Promise.resolve = originalResolve;
		globalThis.setTimeout = originalTimer;
		EventTarget.prototype.addEventListener = originalAdd;
		EventTarget.prototype.removeEventListener = originalRemove;
	}
	expect(calls).toBe(2);
	expect(traps).toBe(0);
	expect(firstResult).toBe(false);
	expect(secondResult).toBe(false);
});

it("uses the captured encoding, decoding and digest operations after global replacement", () => {
	const input = Uint8Array.of(1, 2);
	const expected = kvFingerprint(
		`sha256:${"a".repeat(64)}`,
		"set",
		"request",
		"key",
		"AQI=",
	);
	const originalEncode = TextEncoder.prototype.encode;
	const originalFrom = Buffer.from;
	const originalToString = Buffer.prototype.toString;
	const originalStringify = JSON.stringify;
	const originalUint8Array = globalThis.Uint8Array;
	const originalExec = RegExp.prototype.exec;
	let traps = 0;
	const poison = () => {
		traps++;
		throw new Error("replaced intrinsic");
	};
	let key: boolean | undefined;
	let copied: Uint8Array | undefined;
	let decoded: Uint8Array | undefined;
	let digest: string | undefined;
	try {
		Object.defineProperty(TextEncoder.prototype, "encode", {
			value: poison,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(Buffer, "from", {
			value: poison,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(Buffer.prototype, "toString", {
			value: poison,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(JSON, "stringify", {
			value: poison,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(globalThis, "Uint8Array", {
			value: poison,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(RegExp.prototype, "exec", {
			value: poison,
			configurable: true,
			writable: true,
		});
		key = kvKey("user:😀");
		copied = kvBytes(input, 32);
		decoded = kvDecode("AQI=");
		digest = kvFingerprint(
			`sha256:${"a".repeat(64)}`,
			"set",
			"request",
			"key",
			"AQI=",
		);
	} finally {
		TextEncoder.prototype.encode = originalEncode;
		Buffer.from = originalFrom;
		Buffer.prototype.toString = originalToString;
		JSON.stringify = originalStringify;
		globalThis.Uint8Array = originalUint8Array;
		RegExp.prototype.exec = originalExec;
	}
	expect(traps).toBe(0);
	expect(key).toBe(true);
	expect(copied).toEqual(input);
	expect(decoded).toEqual(input);
	expect(digest).toBe(expected);
});

it("rejects uninspectable authority thenables without invoking their traps", async () => {
	const controller = new AbortController();
	let traps = 0;
	// oxlint-disable-next-line unicorn/no-thenable -- SAFETY: this deliberately tests a hostile thenable getter.
	const hostile = Object.defineProperty({}, "then", {
		get() {
			traps++;
			throw new Error("thenable getter");
		},
	});
	const proxied = new Proxy(Promise.resolve(true), {
		get() {
			traps++;
			throw new Error("promise proxy");
		},
		getPrototypeOf() {
			traps++;
			throw new Error("promise prototype");
		},
	});
	for (const value of [hostile, proxied]) {
		const pending = boundedRivetKvDecision(
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed callback results deliberately exercise the trust boundary.
			() => value as Promise<boolean>,
			controller.signal,
			rivetKvDeadline(controller.signal),
			(decision) => decision,
		);
		await expect(rivetKvNative(pending)).rejects.toThrow(
			"unobservable authority",
		);
	}
	expect(traps).toBe(0);
});

it("does not invoke a scheduled authority after its pending observer fails", async () => {
	const controller = new AbortController();
	let calls = 0;
	const pending = boundedRivetKvDecision(
		() => {
			calls++;
			return true;
		},
		controller.signal,
		rivetKvDeadline(controller.signal),
		() => {
			throw new Error("observer unavailable");
		},
	);
	await expect(rivetKvNative(pending)).rejects.toThrow("observer unavailable");
	await Promise.resolve();
	await Promise.resolve();
	expect(calls).toBe(0);
});
