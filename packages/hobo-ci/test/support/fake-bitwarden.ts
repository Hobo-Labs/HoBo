import {
	constants,
	createHmac,
	generateKeyPairSync,
	publicEncrypt,
	randomBytes,
} from "node:crypto";

import {
	decryptEncString,
	encryptEncString,
} from "../../src/bitwarden-crypto.js";

/**
 * Bitwarden's cloud as a `fetch`, plus the owner's signed-in device that
 * approves (or denies) a login request. It enforces what the real server
 * does where it matters here: a login request is accepted only from a device
 * that already signed in, and every name and key is client-side encrypted.
 */

export const OWNER_EMAIL = "owner@example.com";
export const API_KEY = {
	clientId: "user.0c7e4c1a-7a0e-4a65-9c2e-2f1b8f0d1e2a",
	clientSecret: "Zq8pX1vL0rT5mN3bW7yK2cD9fG4hJ6",
};
export const ORG_ID = "6b1f2a3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
export const OTHER_ORG_ID = "7c2a3b4d-5e6f-4071-9b8c-0d1e2f3a4b5c";

export interface FakeBitwardenOptions {
	/** What the owner's device does with the request. */
	readonly approve?: "approve" | "deny" | "never";
	readonly organizations?: number;
	/** A project and machine account named `hobo` already exist. */
	readonly existing?: boolean;
	/** An approving app that hands over the 32-byte master key (older clients). */
	readonly legacyMasterKey?: boolean;
}

export interface FakeBitwarden {
	readonly fetch: typeof fetch;
	readonly orgKey: Buffer;
	readonly knownDevices: Set<string>;
	readonly requests: { publicKey: string; deviceIdentifier: string }[];
	readonly projects: { id: string; name: string }[];
	readonly accounts: { id: string; name: string }[];
	readonly grants: Map<string, unknown[]>;
	readonly tokens: {
		name: string;
		encryptedPayload: string;
		key: string;
		expireAt: string;
	}[];
	readonly calls: string[];
}

export function fakeBitwarden(
	options: FakeBitwardenOptions = {},
): FakeBitwarden {
	const userKey = randomBytes(64);
	const masterKey = randomBytes(32);
	const orgKey = randomBytes(64);
	const otherOrgKey = randomBytes(64);
	const user = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "der" },
		privateKeyEncoding: { type: "pkcs8", format: "der" },
	});
	const seal = (value: Buffer, spki: Buffer) =>
		`4.${publicEncrypt(
			{
				key: spki,
				format: "der",
				type: "spki",
				padding: constants.RSA_PKCS1_OAEP_PADDING,
				oaepHash: "sha1",
			},
			value,
		).toString("base64")}`;
	// What `stretchMasterKey` makes of the master key, computed independently.
	const stretched = (() => {
		const expand = (info: string) =>
			createHmac("sha256", masterKey)
				.update(Buffer.concat([Buffer.from(info), Buffer.of(1)]))
				.digest();
		return Buffer.concat([expand("enc"), expand("mac")]);
	})();
	const state: FakeBitwarden = {
		fetch: async () => new Response(null, { status: 500 }),
		orgKey,
		knownDevices: new Set(),
		requests: [],
		projects: options.existing
			? [
					{
						id: "11111111-1111-4111-8111-111111111111",
						name: encryptEncString("other", orgKey),
					},
					{
						id: "22222222-2222-4222-8222-222222222222",
						name: encryptEncString("hobo", orgKey),
					},
				]
			: [],
		accounts: options.existing
			? [
					{
						id: "33333333-3333-4333-8333-333333333333",
						name: encryptEncString("hobo", orgKey),
					},
				]
			: [],
		grants: new Map(
			options.existing
				? [
						[
							"33333333-3333-4333-8333-333333333333",
							[
								{
									accessPolicy: {
										grantedProjectId: "11111111-1111-4111-8111-111111111111",
										read: true,
										write: false,
									},
								},
							],
						],
					]
				: [],
		),
		tokens: [],
		calls: [],
	};
	let requestSeen = 0;
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);
		state.calls.push(`${method} ${url.pathname}`);
		const bearer = headers.get("authorization") === "Bearer user-session";
		if (url.pathname === "/connect/token") {
			const form = new URLSearchParams(String(init?.body));
			if (
				form.get("client_id") !== API_KEY.clientId ||
				form.get("client_secret") !== API_KEY.clientSecret
			)
				return Response.json({ error: "invalid_client" }, { status: 400 });
			state.knownDevices.add(form.get("deviceIdentifier") ?? "");
			return Response.json({
				access_token: "user-session",
				token_type: "Bearer",
			});
		}
		if (url.pathname === "/accounts/profile" && bearer) {
			const organizations = [
				{
					id: ORG_ID,
					name: "Acme",
					key: seal(orgKey, user.publicKey),
					enabled: true,
					useSecretsManager: true,
					accessSecretsManager: true,
				},
				...((options.organizations ?? 1) > 1
					? [
							{
								id: OTHER_ORG_ID,
								name: "Side project",
								key: seal(otherOrgKey, user.publicKey),
								enabled: true,
								useSecretsManager: true,
								accessSecretsManager: true,
							},
						]
					: []),
			];
			return Response.json({
				email: OWNER_EMAIL,
				key: encryptEncString(userKey, stretched),
				privateKey: encryptEncString(user.privateKey, userKey),
				organizations,
			});
		}
		if (url.pathname === "/auth-requests/" && method === "POST") {
			const body = JSON.parse(String(init?.body));
			// KnownDevicesOnly: Bitwarden's cloud refuses unknown devices.
			if (!state.knownDevices.has(body.deviceIdentifier))
				return Response.json(
					{ message: "User or known device not found." },
					{ status: 400 },
				);
			state.requests.push(body);
			return Response.json({ id: "req-1" });
		}
		if (url.pathname === "/auth-requests/req-1/response") {
			const request = state.requests[0];
			requestSeen += 1;
			if (
				request === undefined ||
				options.approve === "never" ||
				requestSeen < 2
			)
				return Response.json({ requestApproved: false, responseDate: null });
			if (options.approve === "deny")
				return Response.json({
					requestApproved: false,
					responseDate: "2026-11-16T12:00:00Z",
				});
			const spki = Buffer.from(request.publicKey, "base64");
			return Response.json({
				requestApproved: true,
				responseDate: "2026-11-16T12:00:00Z",
				key: seal(options.legacyMasterKey ? masterKey : userKey, spki),
				masterPasswordHash: options.legacyMasterKey ? "hash" : null,
			});
		}
		if (!bearer)
			return Response.json({ message: "unauthorized" }, { status: 401 });
		const org = `/organizations/${ORG_ID}`;
		if (url.pathname === `${org}/projects` && method === "GET")
			return Response.json({ data: state.projects });
		if (url.pathname === `${org}/projects` && method === "POST") {
			const body = JSON.parse(String(init?.body));
			decryptEncString(body.name, orgKey);
			const project = {
				id: "44444444-4444-4444-8444-444444444444",
				name: body.name,
			};
			state.projects.push(project);
			return Response.json(project);
		}
		if (url.pathname === `${org}/service-accounts` && method === "GET")
			return Response.json({ data: state.accounts });
		if (url.pathname === `${org}/service-accounts` && method === "POST") {
			const body = JSON.parse(String(init?.body));
			const account = {
				id: "55555555-5555-4555-8555-555555555555",
				name: body.name,
			};
			state.accounts.push(account);
			return Response.json(account);
		}
		const granted = /^\/service-accounts\/([^/]+)\/granted-policies$/u.exec(
			url.pathname,
		);
		if (granted !== null && method === "GET")
			return Response.json({
				grantedProjectPolicies: state.grants.get(granted[1] ?? "") ?? [],
			});
		if (granted !== null && method === "PUT") {
			state.grants.set(
				granted[1] ?? "",
				JSON.parse(String(init?.body)).projectGrantedPolicyRequests,
			);
			return Response.json({});
		}
		if (/^\/service-accounts\/[^/]+\/access-tokens$/u.test(url.pathname)) {
			state.tokens.push(JSON.parse(String(init?.body)));
			return Response.json({
				id: "66666666-6666-4666-8666-666666666666",
				clientSecret: "MintedClientSecret0123",
			});
		}
		return Response.json(
			{ message: `unexpected ${method} ${url.pathname}` },
			{ status: 404 },
		);
	};
	return { ...state, fetch: fetchImpl };
}
