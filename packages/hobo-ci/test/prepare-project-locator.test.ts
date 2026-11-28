import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";

import { ownerLocator } from "../src/owner-store.js";
import { prepareGithubConnection } from "../src/prepare.js";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

function box() {
	const home = mkdtempSync(path.join(tmpdir(), "hobo-ci-locator-"));
	homes.push(home);
	return {
		env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") },
		project: path.join(home, "project"),
		elsewhere: path.join(home, "elsewhere"),
	};
}

function prepareIn(cwd: string): PrepareInput {
	return {
		action: "up",
		projectDir: path.join(cwd, "..", "bundled-project"),
		cwd,
		whatIf: false,
		yes: false,
		handOff: true,
		// SAFETY: preparation reads only progress and these output flags.
		run: {
			emitProgress: () => undefined,
			flags: { json: false, quiet: false },
		} as CommandRunInput,
	};
}

const silentOwner = {
	openUrl: async () => undefined,
	captureSecret: async () => undefined,
	holds: () => false,
};

function codeOf(outcome: Awaited<ReturnType<typeof prepareGithubConnection>>) {
	return outcome.kind === "refused" ? outcome.result.code : outcome.kind;
}

describe("hobo ci up reads the owner's store choice saved for the directory it was invoked from", () => {
	it("finds the choice saved for the invoking directory, not the process's working directory or the resolved project", async () => {
		const { env, project } = box();
		await ownerLocator({ cwd: project, env }).write({
			HOBO_SECRET_STORE: "1password",
			OP_VAULT_ID: "k2l3m4n5o6p7q8r9s0t1u2v3w4",
		});
		expect(process.cwd()).not.toBe(project);

		const outcome = await prepareGithubConnection(prepareIn(project), {
			env,
			ownerChannel: silentOwner,
		});

		expect(codeOf(outcome)).not.toBe("HOBO_CI_STORE_CHOICE");
	});

	it("still asks for a choice in a project that has none saved", async () => {
		const { env, project, elsewhere } = box();
		await ownerLocator({ cwd: project, env }).write({
			HOBO_SECRET_STORE: "1password",
			OP_VAULT_ID: "k2l3m4n5o6p7q8r9s0t1u2v3w4",
		});

		const outcome = await prepareGithubConnection(prepareIn(elsewhere), {
			env,
			ownerChannel: silentOwner,
		});

		expect(codeOf(outcome)).toBe("HOBO_CI_STORE_CHOICE");
	});
});
