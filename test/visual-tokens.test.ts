import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
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
		css: connect.css.replace("--mute: #b9b8b1;", "--removed: #b9b8b1;"),
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
	const selectsDesignLint = (file: string) =>
		checksFor(file).some((check) => check.args.join(" ") === "run design:lint");
	assert.ok(selectsDesignLint("site/src/styles/global.css"));
	assert.ok(selectsDesignLint("packages/connect-ui/src/client/styles.css"));
	assert.ok(selectsDesignLint("scripts/check-visual-tokens.mts"));
	assert.ok(!selectsDesignLint("packages/core/src/index.ts"));
	assert.ok(!selectsDesignLint("packages/ui/src/card.tsx"));
});

test("design:lint runs the visual token gate instead of the retired design-md checker", () => {
	// SAFETY: package.json is a committed repo file; scripts values are strings.
	const root = JSON.parse(readFileSync("package.json", "utf8")) as {
		scripts: Record<string, string>;
	};
	assert.match(root.scripts["design:lint"] ?? "", /check-visual-tokens\.mts/u);
	assert.equal(existsSync("scripts/check-design-md.mts"), false);
});
