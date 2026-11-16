/**
 * The owner's 1Password Connect server as an `OnePasswordSdkClient`, so the
 * `1password` SecretsPort works unchanged over it.
 *
 * Connect is a REST server the owner runs; it holds the link to 1Password
 * and returns item fields in plaintext. Every request carries only
 * `Authorization: Bearer <access token>`
 * (https://www.1password.dev/connect/api-reference/), so a run on a remote
 * box can hold a placeholder that the agent's egress proxy replaces with the
 * owner's token: the token never enters the run. The paths are the ones
 * 1Password's own Connect SDK calls: `/v1/vaults/{vault}/items` (list,
 * filtered by title; create) and `/v1/vaults/{vault}/items/{item}` (read,
 * replace).
 */

import {
	ONE_PASSWORD_VALUE_FIELD,
	OnePasswordError,
	type OnePasswordItem,
	type OnePasswordItemCreateParams,
	type OnePasswordSdkClient,
} from "@hobo/adapter-1password";
import { z } from "zod";

import type { HttpsOrigin } from "./parsed-values.js";

const ConnectField = z.object({
	id: z.string(),
	label: z.string().optional(),
	type: z.string().optional(),
	purpose: z.string().optional(),
	value: z.string().optional(),
	section: z.object({ id: z.string() }).optional(),
});
const ConnectItem = z.object({
	id: z.string(),
	title: z.string(),
	category: z.string(),
	vault: z.object({ id: z.string() }),
	version: z.number().int().nonnegative().optional(),
	fields: z.array(ConnectField).optional(),
});
const ConnectOverviews = z.array(
	ConnectItem.pick({ id: true, title: true, vault: true }),
);

/** SDK names (`Password`, `Concealed`) as Connect spells them, and back. */
function toConnectCase(value: string): string {
	return value.replace(/([a-z])([A-Z])/gu, "$1_$2").toUpperCase();
}
function fromConnectCase(value: string): string {
	return value
		.toLowerCase()
		.split("_")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

function toItem(raw: z.infer<typeof ConnectItem>): OnePasswordItem {
	return {
		id: raw.id,
		title: raw.title,
		category: fromConnectCase(raw.category),
		vaultId: raw.vault.id,
		version: raw.version ?? 0,
		fields: (raw.fields ?? []).map((field) => ({
			id: field.id,
			title: field.label ?? field.id,
			fieldType: fromConnectCase(field.type ?? "STRING"),
			value: field.value ?? "",
			...(field.section !== undefined
				? { sectionId: field.section.id }
				: undefined),
		})),
	};
}

function toConnectBody(
	item: Pick<OnePasswordItem, "title" | "category" | "vaultId" | "fields"> & {
		readonly id?: string;
		readonly tags?: readonly string[];
	},
): string {
	return JSON.stringify({
		...(item.id !== undefined ? { id: item.id } : undefined),
		title: item.title,
		category: toConnectCase(item.category),
		vault: { id: item.vaultId },
		...(item.tags !== undefined ? { tags: item.tags } : undefined),
		fields: item.fields.map((field) => ({
			id: field.id,
			label: field.title,
			type: toConnectCase(field.fieldType),
			// The built-in password field: Connect marks it by purpose.
			...(field.id === "password" ? { purpose: "PASSWORD" } : undefined),
			value: field.value,
			...(field.sectionId !== undefined
				? { section: { id: field.sectionId } }
				: undefined),
		})),
	});
}

export interface OnePasswordConnectOptions {
	/** The owner's Connect server, parsed where it was read. */
	readonly host: HttpsOrigin;
	/**
	 * The access token, or a placeholder the agent's egress proxy replaces
	 * with the owner's token on the way to `host`.
	 */
	readonly token: string;
	readonly fetch?: typeof fetch;
}

export function createOnePasswordConnectClient(
	options: OnePasswordConnectOptions,
): OnePasswordSdkClient {
	const origin = new URL(options.host);
	const http = options.fetch ?? fetch;

	/** One request, its answer parsed by `schema` at this boundary. */
	async function call<T>(
		operation: string,
		schema: z.ZodType<T>,
		method: string,
		path: string,
		body?: string,
	): Promise<T> {
		let response: Response;
		try {
			response = await http(new URL(path, origin), {
				method,
				headers: {
					authorization: `Bearer ${options.token}`,
					accept: "application/json",
					...(body !== undefined
						? { "content-type": "application/json" }
						: undefined),
				},
				...(body !== undefined ? { body } : undefined),
				redirect: "error",
				signal: AbortSignal.timeout(15_000),
			});
		} catch {
			throw new OnePasswordError(operation, "unavailable");
		}
		if (response.status === 404)
			throw new OnePasswordError(operation, "not-found");
		// 401/403 included: the owner's token has not reached the run yet.
		if (!response.ok) throw new OnePasswordError(operation, "unavailable");
		const parsed = schema.safeParse(await response.json().catch(() => null));
		if (!parsed.success)
			throw new OnePasswordError(operation, "invalid-response");
		return parsed.data;
	}

	const vaultPath = (vaultId: string) =>
		`/v1/vaults/${encodeURIComponent(vaultId)}/items`;

	return {
		items: {
			async list(vaultId) {
				const overviews = await call(
					"list items",
					ConnectOverviews,
					"GET",
					vaultPath(vaultId),
				);
				return overviews.map((item) => ({
					id: item.id,
					title: item.title,
					vaultId: item.vault.id,
				}));
			},
			async get(vaultId, itemId) {
				return toItem(
					await call(
						"read secret",
						ConnectItem,
						"GET",
						`${vaultPath(vaultId)}/${encodeURIComponent(itemId)}`,
					),
				);
			},
			async create(params: OnePasswordItemCreateParams) {
				return toItem(
					await call(
						"create secret",
						ConnectItem,
						"POST",
						vaultPath(params.vaultId),
						toConnectBody(params),
					),
				);
			},
			async put(item) {
				const path = `${vaultPath(item.vaultId)}/${encodeURIComponent(item.id)}`;
				// Connect's PUT replaces the whole item, including metadata that the
				// port does not carry. Re-read it and patch only the secret value.
				const raw = await call("read secret", ConnectItem, "GET", path);
				const current = toItem(raw);
				if (
					raw.version === undefined ||
					current.version !== item.version ||
					current.id !== item.id ||
					current.vaultId !== item.vaultId ||
					current.title !== item.title ||
					current.category !== item.category ||
					current.fields.length !== item.fields.length ||
					current.fields.filter(
						(field) => field.id === ONE_PASSWORD_VALUE_FIELD,
					).length !== 1
				)
					throw new OnePasswordError("update secret", "invalid-response");
				const pending = new Map(
					item.fields.map((field) => [
						JSON.stringify([field.id, field.sectionId ?? null]),
						field,
					]),
				);
				if (pending.size !== item.fields.length)
					throw new OnePasswordError("update secret", "invalid-response");
				let value: string | undefined;
				for (const field of current.fields) {
					const key = JSON.stringify([field.id, field.sectionId ?? null]);
					const updated = pending.get(key);
					if (
						updated === undefined ||
						updated.title !== field.title ||
						updated.fieldType !== field.fieldType ||
						(field.id !== ONE_PASSWORD_VALUE_FIELD &&
							updated.value !== field.value)
					)
						throw new OnePasswordError("update secret", "invalid-response");
					pending.delete(key);
					if (field.id === ONE_PASSWORD_VALUE_FIELD) value = updated.value;
				}
				if (pending.size || value === undefined)
					throw new OnePasswordError("update secret", "invalid-response");
				return toItem(
					await call(
						"update secret",
						ConnectItem,
						"PATCH",
						path,
						JSON.stringify([
							{ op: "add", path: "/fields/password/value", value },
						]),
					),
				);
			},
		},
	};
}
