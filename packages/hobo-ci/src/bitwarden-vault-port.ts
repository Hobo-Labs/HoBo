import type { SecretsAccessResult, SecretsPort } from "@hobo/identity";
import { z } from "zod";

import {
	decryptEncString,
	encryptEncString,
	symmetricKey,
} from "./bitwarden-crypto.js";
import {
	type BitwardenDeviceId,
	type BitwardenEndpoints,
	type BitwardenId,
	type BitwardenSignInKey,
	bitwardenSignIn,
} from "./bitwarden-provision.js";

/**
 * A secret store in a Bitwarden-compatible **vault** rather than Secrets
 * Manager: what Vaultwarden offers, and what a Bitwarden organization without
 * Secrets Manager offers. Each secret is a secure note in one organization
 * collection (`hobo`): its name is the note's name, its value the note's
 * text, both encrypted with the organization key the run holds in memory
 * (from the owner's approved login request). The run signs in to the API with
 * the owner's personal API key, again whenever the session expires.
 *
 * Bitwarden keeps one revision of an item, so a secret has one version: its
 * revision date.
 */

export interface BitwardenVaultPortOptions {
	readonly endpoints: BitwardenEndpoints;
	readonly apiKey: BitwardenSignInKey;
	readonly deviceId: BitwardenDeviceId;
	readonly organizationId: BitwardenId;
	readonly collectionId: BitwardenId;
	/** The organization key (64 bytes). The port never prints or stores it. */
	readonly organizationKey: Buffer;
	readonly fetch: typeof fetch;
}

const SECURE_NOTE = 2;

const syncCiphers = z.object({
	ciphers: z.array(
		z.object({
			id: z.string(),
			type: z.number(),
			organizationId: z.string().nullish(),
			collectionIds: z.array(z.string()).nullish(),
			name: z.string().nullish(),
			notes: z.string().nullish(),
			key: z.string().nullish(),
			revisionDate: z.string(),
			deletedDate: z.string().nullish(),
		}),
	),
});
const savedCipher = z.object({ id: z.string(), revisionDate: z.string() });
const signedIn = z.object({ access_token: z.string().min(1) });

interface Note {
	readonly id: string;
	readonly name: string;
	readonly revisionDate: string;
	/** Decrypt the value only when it is read. */
	readonly value: () => string;
}

export function createBitwardenVaultSecretsPort(
	options: BitwardenVaultPortOptions,
): SecretsPort {
	const orgKey = symmetricKey(options.organizationKey);
	const { endpoints } = options;
	const device = {
		"Device-Type": "25",
		"Device-Identifier": options.deviceId,
		"Bitwarden-Client-Name": "cli",
		"Bitwarden-Client-Version": "2026.1.0",
	};
	let bearer: string | undefined;

	const signIn = async () => {
		const response = await bitwardenSignIn(
			endpoints,
			options.apiKey,
			options.deviceId,
			options.fetch,
		);
		if (!response.ok)
			throw new Error(
				`The Bitwarden server refused the personal API key (HTTP ${response.status}).`,
			);
		bearer = signedIn.parse(await response.json()).access_token;
		return bearer;
	};

	const call = async <T>(
		schema: z.ZodType<T>,
		path: string,
		init: RequestInit = {},
	): Promise<T> => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = bearer ?? (await signIn());
			const headers = new Headers(init.headers);
			headers.set("Accept", "application/json");
			headers.set("Authorization", `Bearer ${token}`);
			for (const [name, value] of Object.entries(device))
				headers.set(name, value);
			const response = await options.fetch(`${endpoints.api}${path}`, {
				...init,
				headers,
			});
			if (response.status === 401 && attempt === 0) {
				bearer = undefined;
				continue;
			}
			if (!response.ok)
				throw new Error(
					`The Bitwarden server refused ${init.method ?? "GET"} ${path} (HTTP ${response.status}).`,
				);
			return schema.parse(await response.json());
		}
		throw new Error("The Bitwarden server refused the session.");
	};

	const decrypt = (text: string, key: Buffer) =>
		decryptEncString(text, key).toString("utf8");

	const notes = async (): Promise<readonly Note[]> => {
		const sync = await call(syncCiphers, "/sync?excludeDomains=true");
		const out: Note[] = [];
		for (const cipher of sync.ciphers) {
			if (
				cipher.type !== SECURE_NOTE ||
				cipher.deletedDate ||
				cipher.organizationId?.toLowerCase() !== options.organizationId ||
				!cipher.collectionIds?.some(
					(id) => id.toLowerCase() === options.collectionId,
				) ||
				!cipher.name
			)
				continue;
			// A note another client saved may carry its own key, wrapped in the
			// organization key.
			const key = cipher.key
				? symmetricKey(decryptEncString(cipher.key, orgKey))
				: orgKey;
			const encryptedNotes = cipher.notes ?? undefined;
			out.push({
				id: cipher.id,
				name: decrypt(cipher.name, key),
				revisionDate: cipher.revisionDate,
				value: () =>
					encryptedNotes === undefined ? "" : decrypt(encryptedNotes, key),
			});
		}
		return out;
	};

	const find = async (name: string) =>
		(await notes()).find((note) => note.name === name);

	const notFound: SecretsAccessResult = {
		status: "denied",
		reason: "No such secret in the collection.",
		code: "secret-not-found",
	};

	const read = (name: string, note: Note): SecretsAccessResult => ({
		status: "ok",
		valueRef: `bitwarden-vault://${options.organizationId}/${options.collectionId}/${encodeURIComponent(name)}`,
		material: note.value(),
		versionId: note.revisionDate,
		source: "provider-federation",
	});

	const body = (name: string, value: string) => ({
		type: SECURE_NOTE,
		organizationId: options.organizationId,
		name: encryptEncString(name, orgKey),
		notes: encryptEncString(value, orgKey),
		secureNote: { type: 0 },
		folderId: null,
		favorite: false,
		reprompt: 0,
	});

	const create = async (name: string, value: string) => {
		const saved = await call(savedCipher, "/ciphers/create", {
			method: "POST",
			headers: { "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				cipher: body(name, value),
				collectionIds: [options.collectionId],
			}),
		});
		return { versionId: saved.revisionDate };
	};

	return {
		id: `bitwarden-vault:${options.organizationId}/${options.collectionId}`,
		kind: "bitwarden",
		async put(name, value) {
			const existing = await find(name);
			if (existing === undefined) return create(name, value);
			const saved = await call(savedCipher, `/ciphers/${existing.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json; charset=utf-8" },
				body: JSON.stringify({
					...body(name, value),
					lastKnownRevisionDate: existing.revisionDate,
				}),
			});
			return { versionId: saved.revisionDate };
		},
		async access(name) {
			const note = await find(name);
			return note === undefined ? notFound : read(name, note);
		},
		async accessVersion(name, versionId) {
			const note = await find(name);
			if (note === undefined) return notFound;
			return note.revisionDate === versionId
				? read(name, note)
				: {
						status: "denied",
						reason: "Bitwarden keeps only the current revision of an item.",
						code: "secret-version-not-found",
					};
		},
		async listVersions(name) {
			const note = await find(name);
			return note === undefined ? [] : [note.revisionDate];
		},
		async createOnly(name, value) {
			if ((await find(name)) !== undefined) return { created: false };
			const saved = await create(name, value);
			return { created: true, versionId: saved.versionId };
		},
	};
}
