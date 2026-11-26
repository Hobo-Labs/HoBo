import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Script } from "node:vm";
import type { CiContext } from "@cloudflare/ci";

const ts: typeof import("typescript") = createRequire(import.meta.url)(
	"typescript",
);

type NativeRequest = Parameters<CiContext["runner"]>[0];
const sourceUrl = new URL(
	"./pipeline/ci-workflow.ts",
	import.meta.resolve("@cloudflare/ci"),
);
const source = ts.createSourceFile(
	"ci-workflow.ts",
	readFileSync(sourceUrl, "utf8"),
	ts.ScriptTarget.ES2022,
	true,
	ts.ScriptKind.TS,
);
const constants = new Set([
	"DEFAULT_STEP_TIMEOUT_MS",
	"DEFAULT_STEP_CONFIG",
	"COMMAND_TIMEOUT_MARGIN_MS",
]);
const functions = new Set(["resolveRunnerConfig", "assertPositiveFinite"]);
const selected = source.statements.filter((statement) => {
	if (ts.isFunctionDeclaration(statement))
		return statement.name !== undefined && functions.has(statement.name.text);
	return (
		ts.isVariableStatement(statement) &&
		statement.declarationList.declarations.some(
			(declaration) =>
				ts.isIdentifier(declaration.name) &&
				constants.has(declaration.name.text),
		)
	);
});
if (selected.length !== 5)
	throw new Error("pinned Cloudflare SDK config contract changed");
const text = ts
	.createPrinter()
	.printFile(ts.factory.updateSourceFile(source, selected));
const javascript = ts.transpileModule(text, {
	compilerOptions: {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.CommonJS,
	},
}).outputText;
const resolver = new Script(
	`${javascript}\nJSON.stringify(resolveRunnerConfig(nativeRequest));`,
	{ filename: "pinned-cloudflare-sdk-config.js" },
);

/** Execute the actual installed SDK's non-exported configuration resolver. */
export function verifyNativeConfig(nativeRequest: NativeRequest): void {
	resolver.runInNewContext({ nativeRequest }, { timeout: 1000 });
}
