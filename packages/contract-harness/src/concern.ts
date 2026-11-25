/**
 * One test per member under test; the cases are data in a `.cases.jsonl`.
 *
 * Replaces the `describe`-per-function / `it`-per-case shape, where the same
 * arrange-act-assert lines are copied into every case and the boilerplate is
 * where the interesting detail hides. A case is a line here, so adding one is a
 * one-line diff and the assertion logic exists once.
 *
 * It also closes a gap a hand-written suite cannot: the subject's callable
 * surface is read at runtime and a member with no cases **fails the suite**, so
 * a new method is red rather than a silent hole. Deliberate exemptions must be
 * named with a reason, and an exemption that no longer applies also fails.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isRecursiveSubset, subsetMismatchPath } from "./subset.js";

export interface ConcernCase {
	readonly method: string;
	readonly name?: string;
	readonly input?: readonly unknown[];
	readonly expect?: unknown;
	/**
	 * Assert a *subset* of the result rather than the whole value.
	 *
	 * This is the shape most existing tests are in: one call, several
	 * assertions about different fields of what came back. Deep equality cannot
	 * express that without restating every field the caller does not care
	 * about, so `expect` alone forces those tests to stay hand-written.
	 */
	readonly subset?: unknown;
	readonly match?: string;
	readonly throws?: string;
	/**
	 * A subset match against the thrown error itself.
	 *
	 * Deliberately one key rather than `throwsCode`/`throwsName`/…: this repo
	 * has two error idioms — some carry a `code`, others carry `name` plus
	 * structured fields like `declaration`/`path` — and a subset covers both
	 * without the format growing a key per field. Matching only the message
	 * would pin prose that is meant to stay editable, while these are the parts
	 * callers actually branch on.
	 */
	readonly throwsSubset?: Readonly<Record<string, unknown>>;
}

const KEYS = new Set([
	"method",
	"name",
	"input",
	"expect",
	"subset",
	"match",
	"throws",
	"throwsSubset",
]);

export function parseConcernCases(
	text: string,
	source = "cases",
): readonly ConcernCase[] {
	const cases = text.split("\n").flatMap((line, index) => {
		const at = `${source}:${index + 1}`;
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) return [];
		let row: Record<string, unknown>;
		try {
			row = JSON.parse(trimmed) as Record<string, unknown>;
		} catch (error) {
			throw new Error(`${at} is not JSON — ${(error as Error).message}`);
		}
		// A typo'd key would silently disable an assertion, which is the one
		// failure mode a data-driven suite must not have.
		const unknownKey = Object.keys(row).find((key) => !KEYS.has(key));
		if (unknownKey) throw new Error(`${at} has unknown key "${unknownKey}"`);
		if (typeof row.method !== "string" || !row.method)
			throw new Error(`${at} needs a non-empty "method"`);
		const asserts = [row.expect, row.subset, row.match].some(
			(value) => value !== undefined,
		);
		if (row.throwsSubset !== undefined && asserts)
			throw new Error(`${at} cannot assert both a throw and a value`);
		if (row.throws !== undefined && asserts)
			throw new Error(`${at} cannot assert both a throw and a value`);
		if (row.throws === undefined && row.throwsSubset === undefined && !asserts)
			throw new Error(`${at} asserts nothing`);
		return [row as unknown as ConcernCase];
	});
	if (!cases.length) throw new Error(`${source} declares no cases`);
	return cases;
}

/**
 * The surface worth covering: behaviour, not data.
 *
 * For a class or object, a getter counts — a computed property is behaviour,
 * and it is read through the descriptor so listing it never invokes it. For an
 * **ES module namespace** every export is a getter, including plain constants,
 * so getters are resolved to values there and only functions count. A constant
 * is pinned by the cases that use it, not by a case of its own.
 */
export function callableMembers(subject: object): readonly string[] {
	const isModule =
		(subject as { [Symbol.toStringTag]?: string })[Symbol.toStringTag] ===
		"Module";
	const names = new Set<string>();
	for (
		let node: object | null = subject;
		node && node !== Object.prototype;
		node = Object.getPrototypeOf(node) as object | null
	) {
		for (const key of Object.getOwnPropertyNames(node)) {
			if (key === "constructor") continue;
			// Descriptors decide, so listing a getter never invokes it.
			if (!isModule && Object.getOwnPropertyDescriptor(node, key)?.get)
				names.add(key);
			else if (typeof (subject as Record<string, unknown>)[key] === "function")
				names.add(key);
		}
	}
	return [...names].sort();
}

export interface ConcernOptions<T extends object> {
	/** Built per case: the setup, declared once. */
	readonly subject: () => T | Promise<T>;
	readonly cases: string;
	/** Run after each case: the teardown, declared once. */
	readonly teardown?: (subject: T) => unknown;
	/** Members intentionally without cases, each with a reason. */
	readonly uncovered?: Readonly<Record<string, string>>;
}

/**
 * What one call did: returned a value, or threw.
 *
 * Separating this from the assertions is what makes them testable at all. The
 * previous shape ran the checks inside the same `try` that wrapped the call, so
 * the catch could not tell a failure of the subject from a failure of an
 * assertion — and the "expected a throw" guard was caught by its own catch and
 * then matched by its own regex, which is how a `throws` case that returned
 * normally passed green.
 */
export type CaseOutcome =
	| { readonly returned: unknown }
	| { readonly threw: unknown };

/** Every assertion the format can express, in one place, over a finished call. */
export function assertCase(row: ConcernCase, outcome: CaseOutcome): void {
	const wantsThrow = row.throws !== undefined || row.throwsSubset !== undefined;
	if ("threw" in outcome) {
		const error = outcome.threw;
		if (!wantsThrow) throw error;
		if (row.throws !== undefined)
			expect((error as Error).message).toMatch(new RegExp(row.throws, "u"));
		if (
			row.throwsSubset !== undefined &&
			!isRecursiveSubset(row.throwsSubset, error)
		)
			expect.unreachable(
				`thrown error mismatch at ${subsetMismatchPath(row.throwsSubset, error)} — got ${(error as Error).name}: ${(error as Error).message}`,
			);
		return;
	}
	const actual = outcome.returned;
	if (wantsThrow)
		expect.unreachable(
			`expected a throw matching ${row.throws ?? JSON.stringify(row.throwsSubset)}, got ${JSON.stringify(actual)}`,
		);
	if (row.match !== undefined)
		// Objects are stringified so a case can match into a returned errors
		// array without needing a path expression.
		expect(
			typeof actual === "string" ? actual : JSON.stringify(actual),
		).toMatch(new RegExp(row.match, "u"));
	if (row.subset !== undefined && !isRecursiveSubset(row.subset, actual))
		expect.unreachable(
			`result mismatch at ${subsetMismatchPath(row.subset, actual)} — got ${JSON.stringify(actual)}`,
		);
	if (row.expect !== undefined) expect(actual).toEqual(row.expect);
}

export function describeConcern<T extends object>(
	name: string,
	options: ConcernOptions<T>,
): void {
	const cases = parseConcernCases(
		readFileSync(options.cases, "utf8"),
		options.cases,
	);
	const byMethod = new Map<string, ConcernCase[]>();
	for (const row of cases)
		byMethod.set(row.method, [...(byMethod.get(row.method) ?? []), row]);

	describe(name, () => {
		it("covers every member", async () => {
			const members = callableMembers(await options.subject());
			// Named, not counted: a count tells whoever added the method nothing.
			expect(
				members.filter(
					(m) => !byMethod.has(m) && options.uncovered?.[m] === undefined,
				),
			).toEqual([]);
			expect(
				Object.keys(options.uncovered ?? {}).filter(
					(m) => !members.includes(m) || byMethod.has(m),
				),
				"exemptions that no longer apply",
			).toEqual([]);
		});

		for (const [method, rows] of [...byMethod].sort())
			it.each(
				rows.map((r) => [r.name ?? JSON.stringify(r.input ?? []), r]),
			)(`${method} %s`, async (_label, row) => {
				const subject = await options.subject();
				let outcome: CaseOutcome;
				try {
					const member = (subject as Record<string, unknown>)[method];
					outcome = {
						returned:
							typeof member === "function"
								? await (member as (...a: unknown[]) => unknown).apply(
										subject,
										[...(row.input ?? [])],
									)
								: member,
					};
				} catch (error) {
					outcome = { threw: error };
				} finally {
					await options.teardown?.(subject);
				}
				assertCase(row, outcome);
			});
	});
}
