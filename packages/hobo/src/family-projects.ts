import {
	type CommandRunInput,
	type LifecycleFlags,
	type ProjectResolution,
	resolveFamilyProject,
} from "@hobo/cli";
import { cdProjectDir } from "@hobo/hobo-cd";
import { ciProjectDir } from "@hobo/hobo-ci";

const BUNDLED_CI_PROJECT: string | undefined = ciProjectDir();
const BUNDLED_CD_PROJECT: string | undefined = cdProjectDir();

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
