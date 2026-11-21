import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createGithubAppManifest } from "@hobo/ci-gh-actions";

/**
 * GitHub, answering from the provider side of
 * contracts/pacts/github-app-manifest.pact.json: the App manifest's
 * conversion, then the App and its hook as the real verifier reads them.
 * A converted code is spent, as on GitHub: redeeming it again is a 404.
 */
export function pactGithub(RELAY: string, OWNER_ID: number) {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
	});
	const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

	const reviewed = createGithubAppManifest({
		name: "HoBo CI",
		relayUrl: RELAY,
		manifestCallbackUrl: `${RELAY}/v1/app-bootstrap/callback`,
		installationCallbackUrl: `${RELAY}/v1/app-registration/install-callback`,
	});

	interface FakeGithub {
		readonly fetch: typeof fetch;
		readonly calls: string[];
	}

	interface PactInteraction {
		readonly request: { readonly method: string; readonly path: string };
		readonly response: { readonly status: number; readonly body: object };
	}

	// The provider side of contracts/pacts/github-app-manifest.pact.json.
	const PACT: { readonly interactions: readonly PactInteraction[] } =
		JSON.parse(
			readFileSync(
				fileURLToPath(
					new URL(
						"../../contracts/pacts/github-app-manifest.pact.json",
						import.meta.url,
					),
				),
				"utf8",
			),
		);

	/** The pact's requests, in order: what the flow must call. */
	const PACT_CALLS = PACT.interactions.map(
		(interaction) =>
			`${interaction.request.method} ${interaction.request.path}`,
	);

	// GitHub, answering from the pact: the reviewed permissions and events are
	// added to the App bodies and the per-run key replaces the pem placeholder.
	function fakeGithub(ownerId = OWNER_ID, ownerType = "User"): FakeGithub {
		const calls: string[] = [];
		const spent = new Set<string>();
		return {
			calls,
			async fetch(input, init) {
				const url = new URL(String(input));
				const call = `${init?.method ?? "GET"} ${url.pathname}`;
				calls.push(call);
				if (call.endsWith("/conversions")) {
					if (spent.has(call))
						return new Response('{"message":"Not Found"}', { status: 404 });
					spent.add(call);
				}
				if (call.startsWith("GET /app")) {
					const bearer = new Headers(init?.headers).get("authorization");
					const parts = bearer?.replace(/^Bearer /u, "").split(".") ?? [];
					if (
						parts.length !== 3 ||
						!parts[2] ||
						!createVerify("RSA-SHA256")
							.update(`${parts[0]}.${parts[1]}`)
							.verify(publicKey, Buffer.from(parts[2], "base64url"))
					)
						return new Response(null, { status: 401 });
				}
				const interaction = PACT.interactions.find(
					(candidate) =>
						`${candidate.request.method} ${candidate.request.path}` === call,
				);
				if (interaction === undefined)
					return new Response('{"message":"not found"}', { status: 404 });
				const declared = interaction.response.body;
				const body = {
					...declared,
					...("owner" in declared
						? {
								owner: { id: ownerId, type: ownerType },
								permissions: reviewed.defaultPermissions,
								events: reviewed.defaultEvents,
							}
						: undefined),
					...("pem" in declared ? { pem: PEM } : undefined),
				};
				return new Response(JSON.stringify(body), {
					status: interaction.response.status,
					headers: { "content-type": "application/json" },
				});
			},
		};
	}
	return { publicKey, PEM, reviewed, PACT, PACT_CALLS, fakeGithub };
}
