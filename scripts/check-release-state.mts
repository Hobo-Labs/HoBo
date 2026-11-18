import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflowDirectories = [
	".github/workflows",
	".github/workflows-disabled",
] as const;
const packageSchema = z
	.object({
		name: z.string().optional(),
		private: z.boolean().optional(),
		bin: z.record(z.string(), z.string()).optional(),
	})
	.passthrough();
const failures: string[] = [];

function absolute(relative: string): string {
	return path.join(repoRoot, relative);
}

function read(relative: string): string {
	return readFileSync(absolute(relative), "utf8");
}

function readPackage(relative: string) {
	return packageSchema.parse(JSON.parse(read(relative)));
}

function workflowPath(name: string): string | undefined {
	return workflowDirectories
		.map((directory) => `${directory}/${name}`)
		.find((relative) => existsSync(absolute(relative)));
}

const publishWorkflow = workflowPath("publish.yml");
if (publishWorkflow === undefined) failures.push("missing publish workflow");

const cliPackage = readPackage("packages/cli/package.json");
const productPackage = readPackage("packages/hobo/package.json");
if (cliPackage.bin !== undefined)
	failures.push("@hobo/cli must not expose a product binary");
if (productPackage.bin?.hobo === undefined)
	failures.push("@hobo/hobo must expose bin.hobo");

for (const relative of [
	"packages/camps/package.json",
	"packages/yards/package.json",
	"packages/junctions/package.json",
	"packages/componentize/package.json",
	"packages/stage-gate/package.json",
]) {
	if (!existsSync(absolute(relative))) continue;
	const packageJson = readPackage(relative);
	if (packageJson.private !== true)
		failures.push(`${packageJson.name ?? relative} must be private`);
}

const stageZeroPath = workflowPath("stage-gate-s0.yml");
if (stageZeroPath !== undefined) {
	const workflow = read(stageZeroPath);
	if (!workflow.includes("stage-gate-s0-record-linux"))
		failures.push("stage-gate-s0 workflow lacks its stable artifact name");
	if (workflow.includes("stage-gate-s0-record-ubuntu-latest"))
		failures.push(
			"stage-gate-s0 workflow uses an image-specific artifact name",
		);
}

const hoboCiPath = workflowPath("hobo-ci.yml");
if (hoboCiPath !== undefined) {
	const workflow = read(hoboCiPath);
	if (
		!/^  push:\s*$/mu.test(workflow) ||
		!/branches:\s*\[\s*main\s*\]/u.test(workflow)
	)
		failures.push("hobo-ci workflow must run for pushes to main");
}

const componentize = read("packages/componentize/src/componentize.ts");
if (!/buildWasmContractBytes|contract-shaped|synthetic/iu.test(componentize))
	failures.push("componentize must identify its emitted contract bytes");

if (failures.length > 0) {
	console.error(`release-state: FAIL (${failures.length})`);
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}

console.log("release-state: OK");
