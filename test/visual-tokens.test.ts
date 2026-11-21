import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	checkRepositoryVisualTokens,
	checkVisualTokens,
	contrastRatio,
	listWebUiProjects,
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

function fixtureRoot(): string {
	return mkdtempSync(join(tmpdir(), "visual-tokens-"));
}

test("repository discovery checks the real site and every registered UI palette", () => {
	assert.deepEqual(
		listWebUiProjects().map((project) => project.rel),
		[
			"packages/connect-ui",
			"packages/control-yard",
			"packages/mcp",
			"packages/status-page",
			"site",
		],
	);
	assert.deepEqual(checkRepositoryVisualTokens(), []);
});

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

test("a discovered web UI project without a palette fails closed", () => {
	const root = fixtureRoot();
	try {
		mkdirSync(join(root, "site"), { recursive: true });
		const errors = checkRepositoryVisualTokens(root);
		assert.equal(errors.length, 1);
		assert.match(errors[0] ?? "", /global\.css.*unable to read palette/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an unreadable palette fails closed", () => {
	const root = fixtureRoot();
	try {
		mkdirSync(join(root, "site/src/styles/global.css"), { recursive: true });
		const errors = checkRepositoryVisualTokens(root);
		assert.equal(errors.length, 1);
		assert.match(errors[0] ?? "", /global\.css.*unable to read palette/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an empty palette fails closed", () => {
	const root = fixtureRoot();
	try {
		mkdirSync(join(root, "site/src/styles"), { recursive: true });
		writeFileSync(join(root, "site/src/styles/global.css"), "");
		assert.deepEqual(checkRepositoryVisualTokens(root), [
			"site/src/styles/global.css: palette is empty",
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("marked and framework-based UI projects require a reviewed contract", () => {
	for (const manifest of [
		{ hobo: { webUi: true } },
		{ dependencies: { astro: "latest" } },
	]) {
		const root = fixtureRoot();
		try {
			const project = join(root, "examples/unregistered");
			mkdirSync(project, { recursive: true });
			writeFileSync(join(project, "package.json"), JSON.stringify(manifest));
			assert.deepEqual(listWebUiProjects(root), [
				{
					rel: "examples/unregistered",
					reason: manifest.hobo ? "hobo.webUi" : "web framework dependency",
				},
			]);
			assert.deepEqual(checkRepositoryVisualTokens(root), [
				"examples/unregistered: web UI project has no entry in scripts/visual-token-contract.json",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("the relevant check selects source-based visual validation for UI changes", () => {
	const checksFor = (file: string) =>
		selectRelevantChecks({ files: [file], base: "origin/main" }).checks;
	const visualFiles = [
		"site/src/styles/global.css",
		"scripts/check-visual-tokens.mts",
		"scripts/visual-token-contract.json",
		"test/visual-tokens.test.ts",
		"packages/connect-ui/src/client/styles.css",
		"packages/control-yard/public/yard.css",
		"packages/mcp/src/secret-capture/html.ts",
		"packages/mcp/test/secret-capture-design-lint.test.ts",
		"packages/status-page/src/tokens.ts",
		"packages/status-page/test/status-page-design-lint.test.ts",
		"turbo.json",
	];
	for (const file of visualFiles)
		assert.ok(
			checksFor(file).some(
				(check) => check.args.join(" ") === "run design:lint",
			),
			file,
		);
	assert.ok(
		!checksFor("packages/core/src/index.ts").some(
			(check) => check.args.join(" ") === "run design:lint",
		),
	);
});
