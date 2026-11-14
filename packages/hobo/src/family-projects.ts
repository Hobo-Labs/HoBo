import {
	type CommandRunInput,
	type LifecycleFlags,
	type ProjectResolution,
	resolveFamilyProject,
} from "@hobo/cli";

// Where `hobo ci` and `hobo cd` find their HoBo project: `--project`, then
// `HOBO_CI_PROJECT` / `HOBO_CD_PROJECT`, then the project HoBo ships for the
// family, then the working directory when it holds a Bindle.

/** The CI project HoBo ships; set once `@hobo/hobo-ci` exists. */
const BUNDLED_CI_PROJECT: string | undefined = undefined;
/** The CD project HoBo ships; set once `@hobo/hobo-cd` exists. */
const BUNDLED_CD_PROJECT: string | undefined = undefined;

function resolve(
	family: "ci" | "cd",
	bundled: string | undefined,
	input: CommandRunInput,
	flags: LifecycleFlags,
): ProjectResolution {
	return resolveFamilyProject({
		family,
		flags,
		cwd: input.flags.cwd,
		env: process.env,
		bundled,
	});
}

export function resolveCiProject(
	input: CommandRunInput,
	flags: LifecycleFlags,
): ProjectResolution {
	return resolve("ci", BUNDLED_CI_PROJECT, input, flags);
}

export function resolveCdProject(
	input: CommandRunInput,
	flags: LifecycleFlags,
): ProjectResolution {
	return resolve("cd", BUNDLED_CD_PROJECT, input, flags);
}
