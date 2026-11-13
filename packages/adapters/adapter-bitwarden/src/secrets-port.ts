/**
 * The `bitwarden` SecretsPort (ADR-0113): one Secrets Manager secret per key
 * in the bound project. `valueRef` names the organization, project and
 * secret id, never the value.
 *
 * Not secretless: Bitwarden Secrets Manager machine accounts sign in with an
 * access token (no workload-identity federation documented, checked
 * 2026-11-12). HoBo uses this port on the owner's side, not for the hosted
 * relay's runtime reads (ADR-0179 amendment "Secretless first").
 */

import type { SecretsAccessResult, SecretsPort } from "@hobo/identity";
import {
	type ParsedBitwardenBinding,
	parseBitwardenSecretName,
} from "./binding.js";
import { BitwardenError } from "./errors.js";
import type { BitwardenSdkClient, BitwardenSecret } from "./sdk-port.js";

export function bitwardenSecretRef(
	binding: ParsedBitwardenBinding,
	secretId: string,
): string {
	return `bitwarden://${binding.organizationId}/${binding.projectId}/${secretId}`;
}

function versionOf(secret: BitwardenSecret): string {
	const date = new Date(secret.revisionDate);
	if (Number.isNaN(date.getTime()))
		throw new BitwardenError("read secret", "invalid-response");
	return date.toISOString();
}

export function createBitwardenSecretsPort(options: {
	readonly client: BitwardenSdkClient;
	readonly binding: ParsedBitwardenBinding;
	readonly id?: string;
}): SecretsPort {
	const { client, binding } = options;

	async function call<T>(operation: string, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof BitwardenError) throw error;
			throw new BitwardenError(operation, "unavailable");
		}
	}

	async function find(name: string): Promise<BitwardenSecret | undefined> {
		const key = parseBitwardenSecretName(name);
		const { data } = await call("list secrets", () =>
			client.secrets().list(binding.organizationId),
		);
		for (const candidate of data.filter((secret) => secret.key === key)) {
			const secret = await call("read secret", () =>
				client.secrets().get(candidate.id),
			);
			// A key can repeat across projects; only the bound project counts.
			if (secret.projectId === binding.projectId) return secret;
		}
		return undefined;
	}

	async function access(name: string): Promise<SecretsAccessResult> {
		try {
			const secret = await find(name);
			if (secret === undefined)
				return {
					status: "denied",
					reason: "bitwarden read failed: not-found",
					code: "secret-not-found",
				};
			return {
				status: "ok",
				valueRef: bitwardenSecretRef(binding, secret.id),
				material: secret.value,
				versionId: versionOf(secret),
				source: "static-escape",
			};
		} catch (error) {
			const code = error instanceof BitwardenError ? error.code : "unavailable";
			return {
				status: "denied",
				reason: `bitwarden read failed: ${code}`,
				code: `bitwarden-${code}`,
			};
		}
	}

	return {
		id: options.id ?? `secrets:bitwarden:${binding.projectId}`,
		kind: "bitwarden",
		async put(name, value) {
			const key = parseBitwardenSecretName(name);
			const existing = await find(key);
			const written = await call(
				existing ? "update secret" : "create secret",
				() =>
					existing
						? client
								.secrets()
								.update(
									binding.organizationId,
									existing.id,
									key,
									value,
									existing.note,
									[binding.projectId],
								)
						: client
								.secrets()
								.create(binding.organizationId, key, value, "", [
									binding.projectId,
								]),
			);
			return { versionId: versionOf(written) };
		},
		access,
		async accessVersion(name, versionId) {
			const current = await access(name);
			if (current.status === "ok" && current.versionId !== versionId)
				return {
					status: "denied",
					reason: "only the current revision is read",
					code: "secret-version-not-found",
				};
			return current;
		},
		async listVersions(name) {
			const secret = await find(name);
			return Object.freeze(secret ? [versionOf(secret)] : []);
		},
	};
}
