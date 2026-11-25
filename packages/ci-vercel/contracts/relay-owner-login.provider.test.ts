import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
	ORIGIN,
	openStatelessRelay,
	type StatelessHarness,
} from "../test/stateless-harness.js";

const SEALED_EXAMPLES = new Set(["D", "S", "C"].map((c) => c.repeat(52)));
const SEALED = /^[A-Za-z0-9_-]{40,1000}$/u;

const pact = z
	.object({
		consumer: z.object({ name: z.literal("HoboCli") }),
		provider: z.object({ name: z.literal("HoboCiRelayOwnerLogin") }),
		interactions: z.array(
			z.object({
				description: z.string(),
				providerState: z.string(),
				request: z.object({
					method: z.literal("POST"),
					path: z.string(),
					headers: z.record(z.string(), z.string()),
					body: z.record(z.string(), z.json()),
				}),
				response: z.object({
					status: z.number(),
					headers: z.record(z.string(), z.string()),
					body: z.record(z.string(), z.json()),
				}),
			}),
		),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL(
					"../../hobo/contracts/relay-owner-login.pact.json",
					import.meta.url,
				),
				"utf8",
			),
		),
	);

let harness: StatelessHarness | undefined;
afterEach(async () => {
	await harness?.relay.close();
	harness = undefined;
});

it("verifies every interaction HoBo's relay sign-in expects, in order, over the composed relay", async () => {
	expect(pact.interactions).toHaveLength(7);
	let confirmed = false;
	harness = await openStatelessRelay({
		githubFor: async (request) => {
			const url = new URL(request.url);
			if (url.href === "https://github.com/login/device/code")
				return Response.json({
					device_code: "github-device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://github.com/login/device",
					expires_in: 900,
					interval: 5,
				});
			if (url.href === "https://github.com/login/oauth/access_token")
				return Response.json(
					confirmed
						? { access_token: "ghu_owner", token_type: "bearer" }
						: { error: "authorization_pending" },
				);
			if (url.href === "https://api.github.com/user")
				return Response.json({ id: 42 });
			if (url.pathname === "/app/installations/10")
				return Response.json({
					account: { id: 42, login: "owner", type: "User" },
				});
			if (url.pathname === "/repos/Org/Repo/installation")
				return Response.json({ id: 10 });
			if (url.pathname === "/app/installations/10/access_tokens")
				return Response.json({
					token: "ghs_installation_token_for_org_repo",
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				});
			if (url.pathname.startsWith("/applications/"))
				return new Response(null, { status: 204 });
			return undefined;
		},
	});
	const { relay, clock } = harness;
	const actual = new Map<string, string>();
	const substitute = (text: string) =>
		[...actual].reduce(
			(current, [example, value]) => current.replaceAll(example, value),
			text,
		);

	for (const interaction of pact.interactions) {
		const { request, response } = interaction;
		confirmed =
			interaction.providerState ===
			"the owner confirmed the code and administers the installation";
		if (interaction.providerState === "the owner's session has expired")
			clock.advance(8 * 60 * 60 * 1000);
		const answer = await relay.handle(
			new Request(`${ORIGIN}${request.path}`, {
				method: request.method,
				headers: JSON.parse(substitute(JSON.stringify(request.headers))),
				body: substitute(JSON.stringify(request.body)),
			}),
		);
		expect(answer.status, interaction.description).toBe(response.status);
		for (const [name, value] of Object.entries(response.headers))
			expect(answer.headers.get(name), interaction.description).toContain(
				value,
			);
		const body = z.record(z.string(), z.json()).parse(await answer.json());
		expect(Object.keys(body).sort(), interaction.description).toEqual(
			Object.keys(response.body).sort(),
		);
		for (const [field, expected] of Object.entries(response.body)) {
			const value = body[field];
			const example = z.string().safeParse(expected);
			if (example.success && SEALED_EXAMPLES.has(example.data)) {
				const sealed = z.string().regex(SEALED).parse(value);
				actual.set(example.data, sealed);
			} else {
				expect(value, `${interaction.description}: ${field}`).toEqual(expected);
			}
		}
	}
});
