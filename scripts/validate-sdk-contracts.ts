import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const docsRoot = path.join(root, "docs", "design");
const contractPath = path.join(docsRoot, "sdk-contracts.md");
const designIndexPath = path.join(docsRoot, "index.md");
const packageNamespacePath = path.join(docsRoot, "package-namespaces.md");

const requiredSurfaces = [
	{
		heading: "### `.allow(...verbs)`",
		implementation: "HOBO-70",
		conformance: "HOBO-32",
		requiredTerms: [
			"Signature.",
			"Semantics.",
			"Default.",
			"narrow",
			"dynamic",
			"deny-ceiling",
		],
	},
	{
		heading: "### `connector(name)`",
		implementation: "HOBO-43",
		conformance: "HOBO-32",
		requiredTerms: [
			"Signature.",
			"Semantics.",
			"Default.",
			"inferred",
			"policy deny-ceiling",
		],
	},
	{
		heading: "### `ConnectorConnection.token()`",
		implementation: "HOBO-235",
		conformance: "HOBO-54",
		requiredTerms: [
			"Signature.",
			"Semantics.",
			"Default.",
			"escape hatch",
			"connection",
			"subset",
		],
	},
	{
		heading: "### `camp(name, options)`",
		implementation: "HOBO-62",
		conformance: "HOBO-32",
		requiredTerms: [
			"Signature.",
			"Semantics.",
			"Default.",
			"idiom-layer-only",
			"semantics annex",
		],
	},
	{
		heading: "### `yard(name, options)`",
		implementation: "HOBO-62",
		conformance: "HOBO-32",
		requiredTerms: [
			"Signature.",
			"Semantics.",
			"Default.",
			"idiom-layer-only",
			"semantics annex",
		],
	},
	{
		heading: "### `junction(name, options)`",
		implementation: "HOBO-62",
		conformance: "HOBO-32",
		requiredTerms: [
			"Signature.",
			"Semantics.",
			"Default.",
			"idiom-layer-only",
			"semantics annex",
		],
	},
	{
		heading: "### Protocol connectors (`a2a`, `acp`)",
		implementation: "HOBO-88",
		conformance: "HOBO-32",
		requiredTerms: [
			"Signature.",
			"Semantics.",
			"Default.",
			"connector",
			"agent SDK",
			"A2A",
			"ACP",
		],
	},
];

// Values are the packages a symbol may legitimately be imported from in the
// docs. Most symbols have one home; `trainable` has two by design — the
// shipped @hobo/runtime stage-3 decorator (ADR-0125) and the bindles-DSL
// registration factory the walkthrough designs.
const importOwners = new Map<string, string | readonly string[]>([
	["api", "@hobo/bindles"],
	["auth", "@hobo/bindles"],
	["bindle", "@hobo/bindles"],
	["bucket", "@hobo/bindles"],
	["config", "@hobo/bindles"],
	["connector", "@hobo/bindles"],
	["database", "@hobo/bindles"],
	["env", "@hobo/bindles"],
	["experiment", "@hobo/bindles"],
	["flag", "@hobo/bindles"],
	["fromBinding", "@hobo/bindles"],
	["kv", "@hobo/bindles"],
	["objectStore", "@hobo/bindles"],
	["queue", "@hobo/bindles"],
	["rollout", "@hobo/bindles"],
	["secret", "@hobo/bindles"],
	["secretRef", "@hobo/bindles"],
	["slo", "@hobo/bindles"],
	["topic", "@hobo/bindles"],
	["web", "@hobo/bindles"],
	["websocket", "@hobo/bindles"],
	["actor", "@hobo/runtime"],
	["cron", "@hobo/runtime"],
	["createHook", "@hobo/runtime"],
	["FatalError", "@hobo/runtime"],
	["from", "@hobo/runtime"],
	["handler", "@hobo/runtime"],
	["RetryableError", "@hobo/runtime"],
	["sleep", "@hobo/runtime"],
	["start", "@hobo/runtime"],
	["step", "@hobo/runtime"],
	["trainable", ["@hobo/runtime", "@hobo/bindles"]],
	["training", "@hobo/runtime"],
	["workflow", "@hobo/runtime"],
	["command", "@hobo/data"],
	["projection", "@hobo/data"],
	["repo", "@hobo/data"],
	["view", "@hobo/data"],
	["emit", "@hobo/events"],
	["saga", "@hobo/events"],
	["subscribe", "@hobo/events"],
	["camp", "@hobo/camps"],
	["domain", "@hobo/yards"],
	["yard", "@hobo/yards"],
	["junction", "@hobo/junctions"],
	["chaos", "@hobo/sdk"],
	["defineResource", "@hobo/sdk"],
	["dispatcher", "@hobo/sdk"],
	["generateProvider", "@hobo/sdk"],
	["policyPack", "@hobo/sdk"],
	["rule", "@hobo/sdk"],
	["runbook", "@hobo/sdk"],
	["runner", "@hobo/sdk"],
	["waiver", "@hobo/sdk"],
]);

function fail(message: string) {
	console.error(message);
	process.exitCode = 1;
}

function read(filePath: string) {
	return fs.readFileSync(filePath, "utf8");
}

function listMarkdownFiles(dir: string): string[] {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	return entries.flatMap((entry) => {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return listMarkdownFiles(entryPath);
		}
		return entry.name.endsWith(".md") ? [entryPath] : [];
	});
}

function sectionFor(markdown: string, heading: string) {
	const start = markdown.indexOf(heading);
	if (start === -1) {
		return null;
	}
	const next = markdown.indexOf("\n### ", start + heading.length);
	return markdown.slice(start, next === -1 ? undefined : next);
}

function importedBindingName(specifier: string) {
	return specifier
		.trim()
		.replace(/^type\s+/, "")
		.split(/\s+as\s+/i)[0]!
		.trim();
}

function validateContractDoc() {
	if (!fs.existsSync(contractPath)) {
		fail("docs/design/sdk-contracts.md is missing");
		return;
	}

	const contract = read(contractPath);
	const designIndex = read(designIndexPath);

	if (!designIndex.includes("./sdk-contracts.md")) {
		fail("docs/design/index.md does not link docs/design/sdk-contracts.md");
	}

	for (const surface of requiredSurfaces) {
		const section = sectionFor(contract, surface.heading);
		if (!section) {
			fail(`${surface.heading} section missing from sdk-contracts.md`);
			continue;
		}

		for (const label of [
			"Signature.",
			"Semantics.",
			"Default.",
			"Implementation issue.",
			"Conformance issue.",
		]) {
			if (!section.includes(`**${label}**`)) {
				fail(`${surface.heading} missing ${label}`);
			}
		}

		for (const term of surface.requiredTerms) {
			if (!section.includes(term)) {
				fail(`${surface.heading} missing required term: ${term}`);
			}
		}

		if (!section.includes(surface.implementation)) {
			fail(
				`${surface.heading} missing implementation issue ${surface.implementation}`,
			);
		}

		if (!section.includes(surface.conformance)) {
			fail(
				`${surface.heading} missing conformance issue ${surface.conformance}`,
			);
		}
	}

	if (
		!contract.includes(
			"The Yard builder does not expose `approveDefaults(...)` or `autoApprove(...)`",
		)
	) {
		fail(
			"sdk-contracts.md must record the canonical inferred-Camp approval decision",
		);
	}

	if (
		contract.includes("### `approveDefaults(...)") ||
		contract.includes("### `autoApprove(...)") ||
		contract.includes("### `agent()` name collision")
	) {
		fail(
			"sdk-contracts.md must not preserve removed approval shortcuts or public agent SDK contracts",
		);
	}
}

function validatePackageNamespaceDoc() {
	if (!fs.existsSync(packageNamespacePath)) {
		fail("docs/design/package-namespaces.md is missing");
		return;
	}

	const namespaceDoc = read(packageNamespacePath);
	const designIndex = read(designIndexPath);
	const requiredTerms = [
		"ADR-0087",
		"hobo:sdk",
		"@hobo/bindles",
		"@hobo/runtime",
		"@hobo/data",
		"@hobo/events",
		"@hobo/camps",
		"@hobo/yards",
		"@hobo/junctions",
		"@hobo/sdk",
		"@hobo/core",
		"secretRef",
		"connector",
		"must not re-export topology factories",
	];

	if (!designIndex.includes("./package-namespaces.md")) {
		fail(
			"docs/design/index.md does not link docs/design/package-namespaces.md",
		);
	}

	for (const term of requiredTerms) {
		if (!namespaceDoc.includes(term)) {
			fail(`package-namespaces.md missing required term: ${term}`);
		}
	}
}

function validateImportOwners() {
	const importPattern =
		/import\s*\{\s*([^}]+?)\s*\}\s*from\s*["']([^"']+)["']/g;

	for (const filePath of listMarkdownFiles(docsRoot)) {
		const relativePath = path.relative(root, filePath);
		const markdown = read(filePath);
		for (const match of markdown.matchAll(importPattern)) {
			const specifiers = match[1]!
				.split(",")
				.map((specifier) => specifier.trim())
				.filter(Boolean);
			const packageName = match[2]!;

			for (const specifier of specifiers) {
				const bindingName = importedBindingName(specifier);
				const expectedPackage = importOwners.get(bindingName);
				const allowedPackages =
					expectedPackage === undefined
						? undefined
						: Array.isArray(expectedPackage)
							? expectedPackage
							: [expectedPackage];

				if (allowedPackages && !allowedPackages.includes(packageName)) {
					fail(
						`${relativePath}: ${bindingName} imported from ${packageName}; expected ${allowedPackages.join(" or ")}`,
					);
				}

				if (
					bindingName === "agent" &&
					["@hobo/bindles", "@hobo/runtime", "@hobo/sdk"].includes(packageName)
				) {
					fail(
						`${relativePath}: public agent() imports are unsupported; use protocol connectors such as a2a/acp`,
					);
				}
			}
		}
	}
}

function validateDefaultGuards() {
	const markdown = listMarkdownFiles(docsRoot)
		.map((filePath) => read(filePath))
		.join("\n");
	const forbiddenAutoApproveDefaults = [
		/autoApprove[^.\n]{0,120}(default|defaults)[^.\n]{0,40}(prod|production)/i,
		/autoApprove[^.\n]{0,120}(prod|production)[^.\n]{0,40}(default|defaults)/i,
	];

	for (const pattern of forbiddenAutoApproveDefaults) {
		if (pattern.test(markdown)) {
			fail(
				"autoApprove docs imply a production default; contract requires explicit opt-in",
			);
		}
	}
}

validateContractDoc();
validatePackageNamespaceDoc();
validateImportOwners();
validateDefaultGuards();

if (!process.exitCode) {
	console.log(
		`sdk contracts ok: ${requiredSurfaces.length} surfaces, ${importOwners.size} import-owner rules`,
	);
}
