/**
 * The `1password` SecretsPort (ADR-0113): one Password item per secret, its
 * value in the built-in concealed `password` field. `valueRef` is the item's
 * `op://` reference (vault id, item id, field), never the value.
 *
 * Not secretless: the injected client signs in with a service-account token
 * or the owner's desktop app. HoBo uses this port on the owner's side (a
 * source the owner already keeps secrets in), not for the hosted relay's
 * runtime reads, which must sign in with workload identity (ADR-0179
 * amendment "Secretless first").
 */

import type { SecretsAccessResult, SecretsPort } from "@hobo/identity";
import {
	type ParsedOnePasswordBinding,
	parseOnePasswordSecretName,
} from "./binding.js";
import { OnePasswordError, type OnePasswordErrorCode } from "./errors.js";
import type { OnePasswordItem, OnePasswordSdkClient } from "./sdk-port.js";

// public-contract: the field a secret's value is kept in.
export const ONE_PASSWORD_VALUE_FIELD = "password";

function fieldValue(item: OnePasswordItem): string {
	const field = item.fields.find(
		(candidate) => candidate.id === ONE_PASSWORD_VALUE_FIELD,
	);
	if (field === undefined)
		throw new OnePasswordError("read secret", "invalid-response");
	return field.value;
}

export function onePasswordSecretRef(
	binding: ParsedOnePasswordBinding,
	itemId: string,
): string {
	return `op://${binding.vaultId}/${itemId}/${ONE_PASSWORD_VALUE_FIELD}`;
}

export function createOnePasswordSecretsPort(options: {
	readonly client: OnePasswordSdkClient;
	readonly binding: ParsedOnePasswordBinding;
	readonly id?: string;
}): SecretsPort {
	const { client, binding } = options;

	async function call<T>(operation: string, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (error instanceof OnePasswordError) throw error;
			// The SDK's message is not kept: it may quote its input.
			throw new OnePasswordError(operation, "unavailable");
		}
	}

	async function find(name: string): Promise<OnePasswordItem | undefined> {
		const title = parseOnePasswordSecretName(name);
		const overview = (
			await call("list items", () => client.items.list(binding.vaultId))
		).find((item) => item.title === title);
		if (overview === undefined) return undefined;
		return call("read secret", () =>
			client.items.get(binding.vaultId, overview.id),
		);
	}

	function denied(code: OnePasswordErrorCode): SecretsAccessResult {
		return {
			status: "denied",
			reason: `1password read failed: ${code}`,
			code: code === "not-found" ? "secret-not-found" : `1password-${code}`,
		};
	}

	async function access(name: string): Promise<SecretsAccessResult> {
		try {
			const item = await find(name);
			if (item === undefined)
				return {
					status: "denied",
					reason: "1password read failed: not-found",
					code: "secret-not-found",
				};
			return {
				status: "ok",
				valueRef: onePasswordSecretRef(binding, item.id),
				material: fieldValue(item),
				versionId: String(item.version),
				source: "static-escape",
			};
		} catch (error) {
			return denied(
				error instanceof OnePasswordError ? error.code : "unavailable",
			);
		}
	}

	return {
		id: options.id ?? `secrets:1password:${binding.vaultId}`,
		kind: "1password",
		async put(name, value) {
			const existing = await find(name);
			if (existing === undefined) {
				const created = await call("create secret", () =>
					client.items.create({
						category: "Password",
						vaultId: binding.vaultId,
						title: parseOnePasswordSecretName(name),
						fields: [
							{
								id: ONE_PASSWORD_VALUE_FIELD,
								title: ONE_PASSWORD_VALUE_FIELD,
								fieldType: "Concealed",
								value,
							},
						],
						tags: ["hobo"],
					}),
				);
				return { versionId: String(created.version) };
			}
			const updated = await call("update secret", () =>
				client.items.put({
					...existing,
					fields: existing.fields.map((field) =>
						field.id === ONE_PASSWORD_VALUE_FIELD ? { ...field, value } : field,
					),
				}),
			);
			return { versionId: String(updated.version) };
		},
		access,
		async accessVersion(name, versionId) {
			const current = await access(name);
			if (current.status === "ok" && current.versionId !== versionId)
				return {
					status: "denied",
					reason:
						"1password keeps item history in the app; only the current version is read",
					code: "secret-version-not-found",
				};
			return current;
		},
		/** The current version only; history stays in 1Password's item history. */
		async listVersions(name) {
			const item = await find(name);
			return Object.freeze(item ? [String(item.version)] : []);
		},
	};
}
