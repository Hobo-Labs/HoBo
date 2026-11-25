import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { observeCloudflareNativePromise } from "../src/cloudflare-native-promise.js";

it("refuses a native promise whose constructor was replaced", () => {
	const pending = Promise.resolve("ok");
	const original = Object.getOwnPropertyDescriptor(
		Promise.prototype,
		"constructor",
	);
	if (original === undefined) throw new Error("missing Promise constructor");
	let traps = 0;
	let observed = true;
	try {
		Object.defineProperty(Promise.prototype, "constructor", {
			configurable: true,
			get() {
				traps++;
				throw new Error("unexpected constructor getter");
			},
		});
		observed = observeCloudflareNativePromise(
			pending,
			() => {},
			() => {},
		);
	} finally {
		Object.defineProperty(Promise.prototype, "constructor", original);
	}
	expect(observed).toBe(false);
	expect(traps).toBe(0);
});

it("refuses a native promise whose species was replaced without invoking it", () => {
	const pending = Promise.resolve("ok");
	const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
	if (original === undefined) throw new Error("missing Promise species");
	let traps = 0;
	let observed = true;
	try {
		Object.defineProperty(Promise, Symbol.species, {
			configurable: true,
			get() {
				traps++;
				throw new Error("unexpected species getter");
			},
		});
		observed = observeCloudflareNativePromise(
			pending,
			() => {},
			() => {},
		);
	} finally {
		Object.defineProperty(Promise, Symbol.species, original);
	}
	expect(observed).toBe(false);
	expect(traps).toBe(0);
});

it("keeps the exact fulfilled object boxed when Promise and Object prototypes change", () => {
	const packageDir = fileURLToPath(new URL("../", import.meta.url));
	const directory = join(packageDir, "dist");
	expect(existsSync(join(directory, "cloudflare-native-await.js"))).toBe(true);
	const modulePath = pathToFileURL(
		join(directory, "cloudflare-native-await.js"),
	).href;
	const program = `
import { awaitCloudflareNative } from ${JSON.stringify(modulePath)};
const value = {};
const native = Promise.resolve(value);
const objectThen = Object.getOwnPropertyDescriptor(Object.prototype, 'then');
const promiseThen = Object.getOwnPropertyDescriptor(Promise.prototype, 'then');
const race = Object.getOwnPropertyDescriptor(Promise, 'race');
const resolve = Object.getOwnPropertyDescriptor(Promise, 'resolve');
let calls = 0;
Object.defineProperty(Object.prototype, 'then', { configurable: true, get() { calls++; return undefined; } });
Object.defineProperty(Promise.prototype, 'then', { configurable: true, value() { calls++; throw Error('replaced then'); } });
Object.defineProperty(Promise, 'race', { configurable: true, value() { calls++; throw Error('replaced race'); } });
Object.defineProperty(Promise, 'resolve', { configurable: true, value() { calls++; throw Error('replaced resolve'); } });
let same = false;
try { const box = await awaitCloudflareNative(() => native); same = box.value === value; }
finally {
  if (objectThen) Object.defineProperty(Object.prototype, 'then', objectThen); else delete Object.prototype.then;
  Object.defineProperty(Promise.prototype, 'then', promiseThen);
  Object.defineProperty(Promise, 'race', race);
  Object.defineProperty(Promise, 'resolve', resolve);
}
process.stdout.write(JSON.stringify({ same, calls }));
`;
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", program],
		{
			encoding: "utf8",
			timeout: 15_000,
			env: { ...process.env, NODE_OPTIONS: "" },
		},
	);
	expect(result.error).toBeUndefined();
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ same: true, calls: 0 });
});
