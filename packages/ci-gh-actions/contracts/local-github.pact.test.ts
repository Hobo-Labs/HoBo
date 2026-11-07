import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { generateGithubRunnerPact } from "./local-github-pact.js";

it(
	"records the shipped local controller's GitHub CLI consumer interactions with Pact",
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "hobo-github-pact-"));
		try {
			await expect(generateGithubRunnerPact(directory)).resolves.toMatch(
				/\.json$/,
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	Number(process.env.HOBO_TEST_TIMEOUT ?? 30_000),
);
