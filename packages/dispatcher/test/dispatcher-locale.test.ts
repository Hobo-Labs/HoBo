import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import { replayDispatchDecision } from "../src/dispatcher.js";
import { compareCodeUnits } from "../src/order.js";

function evaluate(locale: string, serializedReplay?: string, reverse = false) {
	const fixture = fileURLToPath(
		new URL("./fixtures/dispatcher-locale.mts", import.meta.url),
	);
	const env = {
		...process.env,
		LC_ALL: locale,
		HOBO_TEST_REPLAY_INPUT: serializedReplay,
		HOBO_TEST_REVERSE: reverse ? "1" : "0",
	};
	const child = spawnSync(process.execPath, ["--import", "tsx", fixture], {
		encoding: "utf8",
		env,
	});
	expect(child.status, child.stderr).toBe(0);
	return JSON.parse(child.stdout);
}

it("keeps new dispatch, replay, v2 ordering and credit consumption stable across locales", () => {
	const english = evaluate("en_US.UTF-8");
	const swedish = evaluate("sv_SE.UTF-8", undefined, true);
	const crossLocaleReplay = evaluate(
		"sv_SE.UTF-8",
		JSON.stringify(english.replayInput),
	);
	expect(english.locale).toBe("en-US");
	expect(swedish.locale).toBe("sv-SE");
	expect(english.event).toEqual(swedish.event);
	expect(english.replayEvent).toEqual(english.event);
	expect(swedish.replayEvent).toEqual(swedish.event);
	expect(crossLocaleReplay.replayEvent).toEqual(english.event);
	expect(english.orderingVersion).toBe("code-unit-v1");
	expect(swedish.orderingVersion).toBe("code-unit-v1");
	expect(english.event.data.selectedProvider).toBe("z");
	expect(swedish.v2Selected).toBe("z");
	expect(english.v2Order).toEqual(swedish.v2Order);
	expect(english.rejectedOrder).toEqual(["z", "ä"]);
	expect(swedish.rejectedOrder).toEqual(english.rejectedOrder);
	expect(english.consumed).toEqual(["z"]);
	expect(swedish.consumed).toEqual(english.consumed);
	expect(english.legacySelected).toBe("ä");
	expect(swedish.legacySelected).toBe("z");
}, 30_000);

it("rejects an unknown or malformed replay ordering version", () => {
	for (const orderingVersion of ["future", null, 1])
		expect(() => replayDispatchDecision({ orderingVersion })).toThrow(
			/ordering version/,
		);
});

it("orders arbitrary UTF-16 strings consistently and transitively", () => {
	const string = fc
		.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 8 })
		.map((units) => String.fromCharCode(...units));
	fc.assert(
		fc.property(string, string, string, (a, b, c) => {
			const ab = compareCodeUnits(a, b);
			const ba = compareCodeUnits(b, a);
			expect(ab === 0).toBe(a === b);
			expect(ab + ba).toBe(0);
			if (ab <= 0 && compareCodeUnits(b, c) <= 0)
				expect(compareCodeUnits(a, c)).toBeLessThanOrEqual(0);
		}),
		{ seed: 614481, numRuns: 300 },
	);
});
