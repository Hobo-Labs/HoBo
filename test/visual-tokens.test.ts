import assert from "node:assert/strict";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "vitest";
import {
	checkRepositoryVisualTokens,
	checkVisualTokens,
	contrastRatio,
	listWebUiProjects,
} from "../scripts/check-visual-tokens.mts";
import { selectRelevantChecks } from "../scripts/relevant-check-policy.js";
import contract from "../scripts/visual-token-contract.json" with {
	type: "json",
};

const site = {
	path: "site.css",
	css: readFileSync("site/src/styles/global.css", "utf8"),
};
const connect = {
	path: "connect.css",
	css: readFileSync("packages/connect-ui/src/client/styles.css", "utf8"),
};

function fixtureRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "visual-tokens-"));
	for (const entry of Object.values(contract)) {
		mkdirSync(join(root, entry.project), { recursive: true });
		writeFileSync(join(root, entry.project, "package.json"), "{}\n");
		mkdirSync(dirname(join(root, entry.palette)), { recursive: true });
		copyFileSync(entry.palette, join(root, entry.palette));
	}
	return root;
}

test("repository discovery checks the real site and every registered UI palette", () => {
	assert.deepEqual(
		listWebUiProjects().map((project) => project.rel),
		[
			"packages/ci-dashboard",
			"packages/connect-ui",
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

test("rendered accent text pairs are pinned and meet 4.5:1", () => {
	assert.ok(
		contract["connect-ui"].contrast.some(
			(pair) => pair.foreground === "--spark" && pair.background === "--paper",
		),
		"connect-ui renders --spark error text on --paper",
	);
	const statusTokens = new Map(Object.entries(contract["status-page"].tokens));
	for (const { foreground, background } of contract["status-page"].contrast) {
		const foregroundValue = statusTokens.get(foreground);
		const backgroundValue = statusTokens.get(background);
		assert.ok(
			foregroundValue && backgroundValue,
			`${foreground}/${background}`,
		);
		assert.ok(
			contrastRatio(foregroundValue, backgroundValue) >= 4.5,
			`${foreground} on ${background}`,
		);
	}
	assert.ok(
		contrastRatio("#ff7a63", "#0a0a0a") >= 4.5,
		"connect-ui dark error text",
	);
	assert.deepEqual(checkVisualTokens(site, connect), []);
	assert.deepEqual(checkRepositoryVisualTokens(), []);
});

test("the gate reports unreadable, missing, and absent tokens", () => {
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
	const missingTheme = {
		...connect,
		css: connect.css.replace(
			"prefers-color-scheme: dark",
			"prefers-color-scheme: light",
		),
	};
	assert.match(
		checkVisualTokens(site, missingTheme).join("\n"),
		/expected a :root palette/u,
	);
});

test("same-selector overrides without the anchor are resolved in cascade order", () => {
	const override = {
		...connect,
		css: `${connect.css}\n:root {\n\t--ink: #f2f1ec;\n}\n`,
	};
	assert.match(
		checkVisualTokens(site, override).join("\n"),
		/connect\.css.*--ink on --paper has contrast/u,
	);
});

test("legitimate multi-rule palettes merge in source order", () => {
	const splitDeclarations = "\t--mute: #4a4a46;\n\t--faint: #6e6d68;\n";
	const themeStart = "}\n\n@media (prefers-color-scheme: dark)";
	assert.ok(connect.css.includes(splitDeclarations));
	assert.ok(connect.css.includes(themeStart));
	const split = {
		...connect,
		css: connect.css
			.replace(splitDeclarations, "")
			.replace(
				themeStart,
				`}\n\n:root {\n${splitDeclarations}}\n\n@media (prefers-color-scheme: dark)`,
			),
	};
	assert.deepEqual(checkVisualTokens(site, split), []);
});

test("a contract-listed project without a palette fails closed", () => {
	const root = fixtureRoot();
	try {
		rmSync(join(root, contract.site.palette));
		const errors = checkRepositoryVisualTokens(root);
		assert.equal(errors.length, 1);
		assert.match(errors[0] ?? "", /global\.css.*unable to read palette/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("every contract-listed project directory is required independently of discovery", () => {
	for (const entry of Object.values(contract)) {
		const root = fixtureRoot();
		try {
			rmSync(join(root, entry.project), { recursive: true, force: true });
			assert.deepEqual(checkRepositoryVisualTokens(root), [
				`${entry.project}: contract-listed project directory is missing`,
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("every contract-listed project manifest is required independently of discovery", () => {
	for (const entry of Object.values(contract)) {
		const root = fixtureRoot();
		try {
			rmSync(join(root, entry.project, "package.json"));
			assert.deepEqual(checkRepositoryVisualTokens(root), [
				`${entry.project}/package.json: contract-listed project manifest is missing`,
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("contract-listed projects stay required when discovery markers change", () => {
	for (const entry of Object.values(contract)) {
		const root = fixtureRoot();
		try {
			const manifest = join(root, entry.project, "package.json");
			for (const contents of [
				JSON.stringify({ hobo: { webUi: true } }),
				JSON.stringify({ dependencies: { astro: "latest" } }),
				"{}\n",
			]) {
				writeFileSync(manifest, contents);
				assert.deepEqual(
					listWebUiProjects(root).find(
						(candidate) => candidate.rel === entry.project,
					),
					{ rel: entry.project, reason: "visual token contract" },
				);
				assert.deepEqual(checkRepositoryVisualTokens(root), []);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("an unreadable palette fails closed", () => {
	const root = fixtureRoot();
	try {
		rmSync(join(root, contract.site.palette));
		mkdirSync(join(root, contract.site.palette), { recursive: true });
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
			assert.deepEqual(
				listWebUiProjects(root).find(
					(candidate) => candidate.rel === "examples/unregistered",
				),
				{
					rel: "examples/unregistered",
					reason: manifest.hobo ? "hobo.webUi" : "web framework dependency",
				},
			);
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
		"site/DESIGN.md",
		"scripts/check-visual-tokens.mts",
		"scripts/visual-token-contract.json",
		"test/visual-tokens.test.ts",
		"packages/connect-ui/src/client/styles.css",
		"packages/connect-ui/test/connect-ui-design-lint.test.ts",
		"packages/mcp/src/secret-capture/html.ts",
		"packages/mcp/test/secret-capture-design-lint.test.ts",
		"packages/status-page/src/tokens.ts",
		"packages/status-page/test/status-page-design-lint.test.ts",
		"packages/connect-ui/package.json",
		"packages/mcp/package.json",
		"packages/runtimes/runtime-local/package.json",
		"examples/custom-ui/package.json",
		"apps/web/package.json",
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
