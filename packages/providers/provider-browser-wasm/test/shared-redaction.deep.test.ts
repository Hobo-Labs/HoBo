/**
 * The deep tier of this package's redaction tests (`pnpm run test:deep`): the
 * differential against what it replaced at full size, every pattern it adds
 * swept, and growth measured on hostile text. The fast tier is
 * `shared-redaction.test.ts`.
 */

import { KEPT_LOCATOR } from "@hobo/provider-redaction";
import {
	assertRevealsNoMore,
	DEEP_SEEDS,
} from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";

import { redactHostText } from "../src/errors.js";
import { redactHostText as baseRedact } from "./fixtures/base-redaction.js";

// Its growth on hostile text is the default redactor's, measured once in
// `@hobo/provider-redaction`; this caller adds no shape of its own to it.

// Against the redactor this caller had before (vendored under test/fixtures):
// on generated texts full of credential shapes, separators and control
// characters, every marker half the old one hid stays hidden, and every
// pattern this caller adds is linear on every class and pair of classes.
describe("against the redactor it replaced", () => {
	const LONG = 1_000_000;
	it.each(
		DEEP_SEEDS,
	)("hides every marker the base branch's redactor hid (seed %i)", {
		timeout: 600_000,
	}, (seed) => {
		const hidden = assertRevealsNoMore(
			(text) => baseRedact(text, LONG),
			(text) => redactHostText(text, LONG),
			{ count: 50_000, seed, kept: KEPT_LOCATOR },
		);
		expect(hidden).toBeGreaterThan(1000);
	});
});
