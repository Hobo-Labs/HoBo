#!/usr/bin/env node
/**
 * The relay deploy workflow's credential step (ADR-0179 phase 6, as amended
 * 2026-11-12): read the relay's secret store binding
 * (`packages/ci-vercel/deploy/secret-store.binding.json`, coordinates only),
 * sign in to the store with the job's GitHub Actions OIDC token as the deploy
 * identity, read `VERCEL_TOKEN` from the deploy credential's project, mask it
 * in the job log and hand it to the following steps through `$GITHUB_ENV`.
 *
 * The work is `packages/hobo/src/ci-relay-deploy-credential.ts`; this file
 * only binds it to the runner. Run with `node --import tsx` after the
 * workspace is built (it imports `@hobo/adapter-infisical` and
 * `@hobo/secret-store-claim`).
 */
import { appendFileSync } from "node:fs";
import process from "node:process";
import {
	exportMaskedToGithubEnv,
	RelayDeployCredentialError,
	readRelayDeployToken,
} from "../../packages/hobo/src/ci-relay-deploy-credential.ts";
import {
	loadSecretStoreBinding,
	SecretStoreBindingRefusal,
} from "../../packages/hobo/src/ci-secret-store.ts";

const envFile = process.env.GITHUB_ENV;
if (!envFile) {
	process.stderr.write(
		"::error::GITHUB_ENV is not set: this step runs inside GitHub Actions only.\n",
	);
	process.exit(1);
}
try {
	const binding = loadSecretStoreBinding("packages/ci-vercel");
	if (binding === undefined)
		throw new RelayDeployCredentialError(
			"No secret store is bound to the relay yet (packages/ci-vercel/deploy/secret-store.binding.json).",
		);
	const token = await readRelayDeployToken({ binding, env: process.env });
	exportMaskedToGithubEnv({
		name: "VERCEL_TOKEN",
		value: token,
		writeLog: (line) => process.stdout.write(line),
		appendEnvFile: (text) => appendFileSync(envFile, text, { mode: 0o600 }),
	});
	process.stdout.write(
		"Read the Vercel deploy token from the config service; the next steps have it, masked.\n",
	);
} catch (error) {
	process.stderr.write(
		`::error::${error instanceof RelayDeployCredentialError || error instanceof SecretStoreBindingRefusal ? error.message : "Could not read the deploy token."}\n`,
	);
	process.exit(1);
}
