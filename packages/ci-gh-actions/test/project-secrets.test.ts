import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { expect, it, vi } from "vitest";
import {
	createCiEnvironmentSecretResolver,
	createCiSecretDirectoryResolver,
	resolveCiSecrets,
} from "../src/project-secrets.js";

it("checks the complete operator allowlist before invoking a resolver", async () => {
	const resolver = vi.fn(() => "value");
	await expect(
		resolveCiSecrets(["ALLOWED", "UNAPPROVED"], ["ALLOWED"], resolver),
	).rejects.toThrow("operator-approved");
	expect(resolver).not.toHaveBeenCalled();
});

it("resolves explicit environment bindings and sanitizes provider failures", async () => {
	const resolver = createCiEnvironmentSecretResolver(
		{ TOKEN: "DEPLOY_TOKEN" },
		{ DEPLOY_TOKEN: "sensitive-value" },
	);
	const resolved = await resolveCiSecrets(["TOKEN"], ["TOKEN"], resolver);
	expect(resolved.get("TOKEN")).toBe("sensitive-value");
	expect(JSON.stringify(resolved)).not.toContain("sensitive-value");
	expect(inspect(resolved, { showHidden: true })).not.toContain(
		"sensitive-value",
	);
	await expect(
		resolveCiSecrets(["MISSING"], ["MISSING"], resolver),
	).rejects.toThrow("required secret could not be resolved");
	await expect(
		resolveCiSecrets(["TOKEN"], ["TOKEN"], () => {
			throw new Error("sensitive-value");
		}),
	).rejects.toThrow(/^required secret could not be resolved$/);
});

it("reads bounded regular secret files from an explicit absolute directory", async () => {
	const directory = await mkdtemp(join(tmpdir(), "hobo-ci-secret-"));
	try {
		await writeFile(join(directory, "TOKEN"), "secret-value\n");
		const resolver = createCiSecretDirectoryResolver(directory);
		expect(
			(await resolveCiSecrets(["TOKEN"], ["TOKEN"], resolver)).get("TOKEN"),
		).toBe("secret-value");
		await expect(
			resolveCiSecrets(["../TOKEN"], ["../TOKEN"], resolver),
		).rejects.toThrow();
		await writeFile(join(directory, "LARGE"), "x".repeat(65537));
		await expect(
			resolveCiSecrets(["LARGE"], ["LARGE"], resolver),
		).rejects.toThrow("required secret could not be resolved");
		expect(() => createCiSecretDirectoryResolver("relative")).toThrow();
		if (process.platform !== "win32") {
			execFileSync("mkfifo", [join(directory, "PIPE")]);
			await expect(
				resolveCiSecrets(["PIPE"], ["PIPE"], resolver),
			).rejects.toThrow("required secret could not be resolved");
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
