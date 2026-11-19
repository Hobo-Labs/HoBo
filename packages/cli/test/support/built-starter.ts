import { cp, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createHoboCli } from "../../src/index.js";
import type { VALID_TEMPLATES } from "../../src/types/scaffold.js";
import { RUN_SCRATCH_ENV } from "./run-scratch.js";

type Template = (typeof VALID_TEMPLATES)[number];

const builtStarters = new Map<Template, Promise<string>>();

async function buildStarter(template: Template, root: string): Promise<string> {
	const cli = createHoboCli();
	const steps = [
		{ cwd: root, args: ["new", "app", "-t", template, "--json"] },
		{ cwd: join(root, "app"), args: ["codegen", "--json"] },
		{ cwd: join(root, "app"), args: ["build", "--json"] },
	];
	for (const { cwd, args } of steps) {
		const result = await cli.run(args, { cwd });
		if (result.exitCode !== 0)
			throw new Error(
				`hobo ${args[0]} failed for the ${template} starter: ${result.stdout}${result.stderr}`,
			);
	}
	return join(root, "app");
}

export async function copyBuiltStarter(
	template: Template,
	destination: string,
): Promise<string> {
	const runScratchDirectory = process.env[RUN_SCRATCH_ENV];
	if (!runScratchDirectory) return await buildStarter(template, destination);
	let pending = builtStarters.get(template);
	if (!pending) {
		pending = mkdtemp(
			join(runScratchDirectory, `hobo-built-starter-${template}-`),
		).then((root) => buildStarter(template, root));
		builtStarters.set(template, pending);
		pending.catch(() => builtStarters.delete(template));
	}
	const project = join(destination, "app");
	await cp(await pending, project, { recursive: true });
	return project;
}
