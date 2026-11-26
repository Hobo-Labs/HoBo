/**
 * The repository-locating variables the pins drop from every git they run
 * are git's own `local_repo_env` (what `git rev-parse --local-env-vars`
 * prints), plus GIT_NAMESPACE. GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT
 * from that list are kept on purpose: they configure git, as git itself
 * passes them to a submodule. GIT_CONFIG is dropped like the rest: it only
 * redirects the `git config` command.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

import { gitEnvironment, LOCAL_REPO_ENV } from "../lib/pins-git-core.ts";

const KEPT = ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT"];

const printed = execFileSync("git", ["rev-parse", "--local-env-vars"], {
	encoding: "utf8",
})
	.split("\n")
	.filter(Boolean);

describe("the repository-locating variables", () => {
	it("are every name the installed git prints for --local-env-vars, plus GIT_NAMESPACE", () => {
		const list: readonly string[] = LOCAL_REPO_ENV;
		for (const name of [...printed, "GIT_NAMESPACE"]) {
			assert.ok(list.includes(name), `${name} is in LOCAL_REPO_ENV`);
		}
	});

	it("are dropped from a git's environment, and the configuration ones are kept", () => {
		const given: NodeJS.ProcessEnv = { PATH: "/bin" };
		for (const name of [...printed, "GIT_NAMESPACE"]) given[name] = "x";
		given.GIT_CONFIG_KEY_0 = "a.b";
		given.GIT_CONFIG_VALUE_0 = "c";
		given.GIT_CEILING_DIRECTORIES = "/home";
		const env = gitEnvironment(given);
		for (const name of [...printed, "GIT_NAMESPACE"]) {
			if (KEPT.includes(name)) assert.equal(env[name], "x", `${name} is kept`);
			else assert.equal(env[name], undefined, `${name} is dropped`);
		}
		for (const name of [
			"GIT_CONFIG_KEY_0",
			"GIT_CONFIG_VALUE_0",
			"GIT_CEILING_DIRECTORIES",
			"PATH",
		]) {
			assert.notEqual(env[name], undefined, `${name} is kept`);
		}
	});
});
