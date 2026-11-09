import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHoboCli } from "../../src/index.js";
import type { VALID_TEMPLATES } from "../../src/types/scaffold.js";
import { RUN_SCRATCH_ENV } from "./run-scratch.js";

type Template = (typeof VALID_TEMPLATES)[number];

const built = new Map<Template, Promise<string>>();

async function build(template: Template): Promise<string> {
	// The run's scratch directory (test/support/run-scratch.ts) is removed when the run ends.
	const root = await mkdtemp(
		join(
			process.env[RUN_SCRATCH_ENV] ?? tmpdir(),
			`hobo-built-starter-${template}-`,
		),
	);
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

/**
 * A starter after `hobo new` → `codegen` → `build`, copied into `dir`.
 *
 * Each template is built once per worker (test files share the module graph,
 * `isolate: false`), so every file that needs a built starter pays for one
 * pipeline. The copy is the caller's to change and remove.
 */
export async function copyBuiltStarter(
	template: Template,
	dir: string,
): Promise<string> {
	let pending = built.get(template);
	if (!pending) {
		pending = build(template);
		built.set(template, pending);
		// A failed build is reported to every caller, and retried by the next file.
		pending.catch(() => built.delete(template));
	}
	const project = join(dir, "app");
	await cp(await pending, project, { recursive: true });
	return project;
}
