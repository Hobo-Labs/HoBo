import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";
import {
	checkVisualTokens,
	contrastRatio,
} from "../scripts/check-visual-tokens.mts";
import { selectRelevantChecks } from "../scripts/relevant-check-policy.js";

const site = {
	path: "site.css",
	css: readFileSync("site/src/styles/global.css", "utf8"),
};
const connect = {
	path: "connect.css",
	css: readFileSync("packages/connect-ui/src/client/styles.css", "utf8"),
};

test("the implemented palettes meet text contrast requirements", () => {
	assert.deepEqual(checkVisualTokens(site, connect), []);
	assert.equal(contrastRatio("#000000", "#ffffff"), 21);
	assert.equal(contrastRatio("#ffffff", "#ffffff"), 1);
	assert.throws(() => contrastRatio("red", "#ffffff"), /six-digit hex/u);
});

test("the gate reports unreadable, missing, and ambiguous tokens", () => {
	const unreadable = {
		...site,
		css: site.css.replace("--text: #f2f1ec;", "--text: #0a0a0a;"),
	};
	assert.match(
		checkVisualTokens(unreadable, connect).join("\n"),
		/site\.css.*contrast.*minimum is 4\.5/u,
	);
	const missing = {
		...connect,
		css: connect.css.replace("--mute: #4a4a46;", "--removed: #4a4a46;"),
	};
	assert.match(
		checkVisualTokens(site, missing).join("\n"),
		/connect\.css.*--mute/u,
	);
	const duplicate = {
		...site,
		css: site.css.replace(
			"--text: #f2f1ec;",
			"--text: #f2f1ec; --text: #ffffff;",
		),
	};
	assert.match(
		checkVisualTokens(duplicate, connect).join("\n"),
		/duplicate --text/u,
	);
	const missingTheme = {
		...connect,
		css: connect.css.replace(
			"prefers-color-scheme: dark",
			"prefers-color-scheme: light",
		),
	};
	assert.match(
		checkVisualTokens(site, missingTheme).join("\n"),
		/expected one :root palette/u,
	);
});

test("the relevant check selects source-based visual validation for UI changes", () => {
	const checksFor = (file: string) =>
		selectRelevantChecks({ files: [file], base: "origin/main" }).checks;
	assert.ok(
		checksFor("site/src/styles/global.css").some(
			(check) => check.args.join(" ") === "run design:lint",
		),
	);
	assert.ok(
		checksFor("scripts/check-visual-tokens.mts").some(
			(check) => check.args.join(" ") === "run design:lint",
		),
	);
	assert.ok(
		!checksFor("packages/core/src/index.ts").some(
			(check) => check.args.join(" ") === "run design:lint",
		),
	);
});
