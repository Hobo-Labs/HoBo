/**
 * The `infisical` SecretsPort (ADR-0113, ADR-0179). `access` reads; `put`
 * writes and is used only by `hobo ci` and the deploy workflow, never by the
 * relay, whose identity is read-only. `valueRef` is the `infisical://`
 * SecretRef of the entry; `material` is the value, for mediated use only.
 */

import type { SecretsAccessResult, SecretsPort } from "@hobo/identity";
import type { InfisicalClient } from "./client.js";
import { InfisicalError } from "./errors.js";
import { infisicalSecretRef } from "./secret-ref.js";

function denied(error: InfisicalError): SecretsAccessResult {
	return {
		status: "denied",
		reason: error.message,
		code:
			error.code === "not-found"
				? "secret-not-found"
				: `infisical-${error.code}`,
	};
}

export function createInfisicalSecretsPort(options: {
	readonly client: InfisicalClient;
	readonly id?: string;
}): SecretsPort {
	const { client } = options;
	const { binding } = client;
	async function read(
		name: string,
		version?: number,
	): Promise<SecretsAccessResult> {
		try {
			const secret = await client.getSecret(name, version);
			return {
				status: "ok",
				valueRef: infisicalSecretRef(binding, secret.secretKey),
				material: secret.value,
				versionId: String(secret.version),
				source: "provider-federation",
			};
		} catch (error) {
			return denied(
				error instanceof InfisicalError
					? error
					: new InfisicalError("read secret", "unavailable"),
			);
		}
	}
	return {
		id:
			options.id ??
			`secrets:infisical:${binding.projectId}:${binding.environment}`,
		kind: "infisical",
		async put(name, value) {
			const { version } = await client.putSecret(name, value);
			return { versionId: String(version) };
		},
		access: (name) => read(name),
		async accessVersion(name, versionId) {
			if (!/^[1-9]\d{0,9}$/u.test(versionId))
				return {
					status: "denied",
					reason: "infisical versions are positive integers",
					code: "secret-version-not-found",
				};
			return read(name, Number(versionId));
		},
		/** The current version only; history stays in Infisical's own versioning. */
		async listVersions(name) {
			const names = await client.listSecretNames();
			const entry = names.find((secret) => secret.secretKey === name);
			return Object.freeze(entry ? [String(entry.version)] : []);
		},
	};
}
