import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { foldName, upcaseName } from "../lib/pins-tar.ts";
import { DEFAULT_IGNORABLE, firstIgnorable } from "../lib/pins-tar-names.ts";

interface Table {
	readonly unicode: string;
	readonly fold: readonly (readonly [number, string])[];
	readonly upcase: readonly (readonly [number, number])[];
	readonly unassigned: readonly (readonly [number, number])[];
	readonly ignorable: readonly (readonly [number, number])[];
}

function readTable(): Table {
	const parsed: Table = JSON.parse(
		readFileSync(
			new URL("support/unicode-casefold.json", import.meta.url),
			"utf8",
		),
	);
	return parsed;
}

const TABLE = readTable();

const asBytes = (text: string): string =>
	Buffer.from(text, "utf8").toString("latin1");

const fold = (text: string): string => foldName(asBytes(text));

describe("foldName", () => {
	it("joins every pair Unicode 15.1's full case folding joins", () => {
		assert.equal(TABLE.unicode, "15.1.0");
		assert.ok(TABLE.fold.length > 1000);
		const split = TABLE.fold
			.filter(
				([point, folded]) => fold(String.fromCodePoint(point)) !== fold(folded),
			)
			.map(
				([point, folded]) =>
					`U+${point.toString(16).toUpperCase()} -> ${JSON.stringify(folded)}`,
			);
		assert.deepEqual(split, []);
	});

	it("joins every pair NTFS's simple uppercase joins", () => {
		assert.ok(TABLE.upcase.length > 1000);
		const split = TABLE.upcase
			.filter(
				([point, upper]) =>
					fold(String.fromCodePoint(point)) !==
					fold(String.fromCodePoint(upper)),
			)
			.map(
				([point, upper]) =>
					`U+${point.toString(16).toUpperCase()} -> U+${upper.toString(16).toUpperCase()}`,
			);
		assert.deepEqual(split, []);
	});

	it("folds a name the way it folds its letters: ẞH, ßh and ssh are one name", () => {
		assert.equal(fold("ẞH"), fold("ssh"));
		assert.equal(fold("ßh"), fold("ssh"));
		assert.equal(fold("STRAẞE"), fold("strasse"));
	});
});

describe("upcaseName", () => {
	const upcase = (text: string): string => upcaseName(asBytes(text));
	const simple = new Map(TABLE.upcase);
	const unassigned = (point: number): boolean =>
		TABLE.unassigned.some(([low, high]) => point >= low && point <= high);

	it("is the simple uppercase of every BMP code point of Unicode 15.1", () => {
		const wrong: string[] = [];
		for (let point = 0; point <= 0xffff; point += 1) {
			if ((point >= 0xd800 && point <= 0xdfff) || unassigned(point)) continue;
			const expected = String.fromCodePoint(simple.get(point) ?? point);
			const got = upcase(String.fromCodePoint(point));
			const newer =
				!simple.has(point) && unassigned(got.codePointAt(0) ?? point);
			if (got !== expected && !newer) {
				wrong.push(`U+${point.toString(16).toUpperCase()}`);
			}
		}
		assert.deepEqual(wrong, []);
	});

	it("leaves a name un-normalised, as NTFS does: S, s with dot above and ypogegrammeni, and s, s, prosgegrammeni, dot above are one name", () => {
		assert.equal(upcase("Ss\u0345\u0307"), upcase("ss\u1fbe\u0307"));
		assert.notEqual(fold("Ss\u0345\u0307"), fold("ss\u1fbe\u0307"));
	});
});

function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
		mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
		return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
	};
}

describe("random names", () => {
	const FOLD = new Map(TABLE.fold);
	const UPPER = new Map(TABLE.upcase);
	const caseless = (text: string): string =>
		[...text.normalize("NFD")]
			.map((char) => FOLD.get(char.codePointAt(0) ?? 0) ?? char)
			.join("")
			.normalize("NFD");
	const ntfs = (text: string): string =>
		[...text]
			.map((char) => {
				const point = char.codePointAt(0) ?? 0;
				const upper = point <= 0xffff ? UPPER.get(point) : undefined;
				return upper === undefined ? char : String.fromCodePoint(upper);
			})
			.join("");
	const POOL = [
		...new Set([
			...TABLE.fold.map(([point]) => point),
			...TABLE.upcase.flatMap(([point, upper]) => [point, upper]),
		]),
	].map((point) => String.fromCodePoint(point));
	const MARKS = [
		0x300, 0x301, 0x307, 0x308, 0x30c, 0x313, 0x314, 0x31b, 0x323, 0x327, 0x328,
		0x342, 0x345,
	].map((point) => String.fromCodePoint(point));
	const LETTERS = [..."aAiIsSkKfFtT"];

	it("no two names one file under full case folding or under NTFS's uppercase are distinct to the reader, over 10,000 groups", (t) => {
		const next = seeded(20261031);
		const pick = (from: readonly string[]): string =>
			from[Math.floor(next() * from.length)] ?? "";
		const groups = new Map<string, Set<string>>();
		const add = (key: string, name: string): void => {
			const group = groups.get(key) ?? new Set<string>();
			group.add(name);
			groups.set(key, group);
		};
		for (let i = 0; i < 450_000; i += 1) {
			let name = "";
			const length = 1 + Math.floor(next() * 4);
			for (let c = 0; c < length; c += 1) {
				const roll = next();
				name += pick(roll < 0.5 ? POOL : roll < 0.75 ? MARKS : LETTERS);
			}
			add(`caseless:${caseless(name)}`, name);
			add(`ntfs:${ntfs(name)}`, name);
		}
		const shared = [...groups.values()].filter((group) => group.size > 1);
		assert.ok(shared.length >= 10_000, `${shared.length} groups`);
		const distinct: string[] = [];
		const one = (a: string, b: string): boolean =>
			foldName(asBytes(a)) === foldName(asBytes(b)) ||
			upcaseName(asBytes(a)) === upcaseName(asBytes(b));
		for (const group of shared) {
			const names = [...group];
			for (const [i, a] of names.entries()) {
				for (const b of names.slice(i + 1)) {
					if (!one(a, b))
						distinct.push(`${JSON.stringify(a)} ${JSON.stringify(b)}`);
				}
			}
		}
		assert.deepEqual(distinct, []);
		t.diagnostic(
			`${shared.length} groups of names that are one file, ${shared.filter((group) => [...group].some((a) => [...group].some((b) => foldName(asBytes(a)) !== foldName(asBytes(b))))).length} of them joined only by the NTFS key`,
		);
	});
});

describe("default-ignorable code points", () => {
	it("are Unicode 15.1's Default_Ignorable_Code_Point, every range of it", () => {
		assert.deepEqual(DEFAULT_IGNORABLE, TABLE.ignorable);
	});

	it("are found in a name, whichever of them it holds and wherever", () => {
		const missed: string[] = [];
		for (const [low, high] of TABLE.ignorable) {
			for (let point = low; point <= high; point += 1) {
				const name = asBytes(`mi${String.fromCodePoint(point)}rror`);
				if (firstIgnorable(name) !== point) {
					missed.push(`U+${point.toString(16).toUpperCase()}`);
				}
			}
		}
		assert.deepEqual(missed, []);
		assert.equal(firstIgnorable(asBytes("mirror")), undefined);
		assert.equal(firstIgnorable(asBytes("caf\u00e9")), undefined);
	});
});
