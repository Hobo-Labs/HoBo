import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import { digest } from "../../src/replay/divergence.js";
import {
	compareCanonicalEventOrder,
	stableStringify,
	stableValue,
} from "../../src/replay/equivalence.js";

const state = { ä: 2, z: 3, a: 1 };

it("canonicalizes equivalent Unicode keys independently of insertion order", () => {
	const first = { é: 1, "e\u0301": 2 };
	const second = { "e\u0301": 2, é: 1 };
	expect(stableStringify(first)).toBe(stableStringify(second));
	expect(digest(first)).toBe(digest(second));
});

it("produces the same canonical bytes, digest and event ordering under different locales", () => {
	const helper = fileURLToPath(
		new URL("./helpers/ordering-probe.ts", import.meta.url),
	);
	const outputs = ["en_US.UTF-8", "sv_SE.UTF-8"].map((locale) =>
		spawnSync(process.execPath, ["--import", "tsx", helper], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: locale },
		}),
	);
	for (const result of outputs) expect(result.status, result.stderr).toBe(0);
	const [english, swedish] = outputs.map((result) => JSON.parse(result.stdout));
	expect(english.canonical).toBe(swedish.canonical);
	expect(english.digest).toBe(swedish.digest);
	expect(english.order).toEqual(swedish.order);
});

it("is insertion independent for generated Unicode keys and event orders", () => {
	fc.assert(
		fc.property(
			fc.uniqueArray(
				fc.constantFrom(
					"a",
					"z",
					"ä",
					"é",
					"e\u0301",
					"__proto__",
					"constructor",
					"2",
				),
				{ minLength: 1 },
			),
			(keys) => {
				const entries = keys.map((key) => [key, `value:${key}`] as const);
				const left = Object.fromEntries(entries);
				const right = Object.fromEntries([...entries].reverse());
				expect(stableStringify(left)).toBe(stableStringify(right));
				expect(digest(left)).toBe(digest(right));
				const events = keys.map((streamId) => ({
					id: streamId,
					streamId,
					seq: 1,
					type: "value",
					data: null,
				}));
				expect([...events].sort(compareCanonicalEventOrder)).toEqual(
					[...events].reverse().sort(compareCanonicalEventOrder),
				);
			},
		),
		{ seed: 614614, numRuns: 150 },
	);
});

it("orders distinct Map entries consistently when their keys encode alike", () => {
	const a = new Map([
		[{ x: 1 }, "a"],
		[{ x: 1 }, "b"],
	]);
	const b = new Map([...a.entries()].reverse());
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this deliberately exercises the runtime's Map branch beyond its JSON type.
	const first = stableValue(a as never);
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this deliberately exercises the runtime's Map branch beyond its JSON type.
	const second = stableValue(b as never);
	expect(JSON.stringify(first)).toBe(JSON.stringify(second));
});

it("preserves callback use of the existing unary helpers", () => {
	const states = [state, { a: 4 }];
	expect(states.map(stableStringify)).toEqual(
		states.map((entry) => stableStringify(entry)),
	);
	expect(states.map(stableValue)).toEqual(
		states.map((entry) => stableValue(entry)),
	);
	expect(states.map(digest)).toEqual(states.map((entry) => digest(entry)));
});
