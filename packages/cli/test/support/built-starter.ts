import { cp, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createHoboCli } from "../../src/index.js";
import type { VALID_TEMPLATES } from "../../src/types/scaffold.js";
import { RUN_SCRATCH_ENV } from "./run-scratch.js";

type Template = (typeof VALID_TEMPLATES)[number];

const built = new Map<Template, Promise<string>>();

/** `hobo new` → `codegen` → `build` of `template` in `root`; returns the project. */
async function build(template: Template, root: string): Promise<string> {
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
 * A starter after `hobo new` → `codegen` → `build`, in `dir`.
 *
 * Under the cli config each template is built once per worker in the run's
 * scratch directory (test/support/run-scratch.ts, removed when the run ends)
 * and copied to each caller: test files share the module graph
 * (`isolate: false`), so every file that needs a built starter pays for one
 * pipeline. Without that directory (another config), nothing outlives the
 * caller, so the starter is built straight into `dir`. Either way the result
 * is the caller's to change and remove.
 */
export async function copyBuiltStarter(
	template: Template,
	dir: string,
): Promise<string> {
	const scratch = process.env[RUN_SCRATCH_ENV];
	if (!scratch) return await build(template, dir);
	let pending = built.get(template);
	if (!pending) {
		pending = mkdtemp(join(scratch, `hobo-built-starter-${template}-`)).then(
			(root) => build(template, root),
		);
		built.set(template, pending);
		// A failed build is reported to every caller, and retried by the next file.
		pending.catch(() => built.delete(template));
	}
	const project = join(dir, "app");
	await cp(await pending, project, { recursive: true });
	return project;
}
