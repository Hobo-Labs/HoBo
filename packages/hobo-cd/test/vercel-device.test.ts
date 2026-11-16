import type { CommandRunInput, PrepareInput } from "@hobo/cli";
import type { SavedSettings } from "@hobo/connect-ui";
import type { OpenedSecretStore, SecretStoreOpening } from "@hobo/hobo-ci";
import { createMemorySecretsPort } from "@hobo/identity";
import { describe, expect, it } from "vitest";

import {
	OWNER_DEVICE_LINE_PREFIX,
	prepareVercelConnection,
	VERCEL_DEVICE_AUTHORIZATION_URL,
	VERCEL_DEVICE_TOKEN_URL,
	vercelDeviceTeam,
	vercelDeviceToken,
} from "../src/index.js";

// `hobo cd up --hand-off` from a box the owner cannot reach: Vercel is
// connected with the device grant (the owner approves on vercel.com from any
// device), nothing is served on this machine, and the token goes only to the
// owner's store and the run's vault, never to a progress line.

const TOKEN = "vercel-device-token";

function fakeVercel(
	replies: readonly string[],
	teams = [{ id: "team_abc", slug: "acme" }],
) {
	const calls: string[] = [];
	let polls = 0;
	const http = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === VERCEL_DEVICE_AUTHORIZATION_URL)
			return Response.json({
				device_code: "dev-code",
				user_code: "ABCD-EFGH",
				verification_uri: "https://vercel.com/device",
				verification_uri_complete:
					"https://vercel.com/device?user_code=ABCD-EFGH",
				expires_in: 600,
				interval: 5,
			});
		if (url === VERCEL_DEVICE_TOKEN_URL) {
			const reply = replies[polls] ?? "authorization_pending";
			polls += 1;
			return reply === "ok"
				? Response.json({ access_token: TOKEN, token_type: "Bearer" })
				: Response.json({ error: reply }, { status: 400 });
		}
		if (url === "https://api.vercel.com/v2/teams")
			return Response.json({ teams, pagination: { next: null } });
		return new Response("{}", { status: 404 });
	};
	return { http, calls };
}

const instant = async () => undefined;

describe("vercelDeviceToken", () => {
	it("names the link and code, waits through pending and slow_down, and keeps the token off the line", async () => {
		const lines: string[] = [];
		const slept: number[] = [];
		const { http } = fakeVercel(["authorization_pending", "slow_down", "ok"]);
		const result = await vercelDeviceToken({
			fetch: http,
			emit: (line) => lines.push(line),
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		expect(result.token).toBe(TOKEN);
		expect(slept).toEqual([5000, 5000, 10000]);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(
			new RegExp(
				`^${OWNER_DEVICE_LINE_PREFIX} https://vercel\\.com/device\\?user_code=ABCD-EFGH code=ABCD-EFGH `,
			),
		);
		expect(lines.join("\n")).not.toContain(TOKEN);
	});

	it("refuses a declined or expired sign-in", async () => {
		for (const [reply, code] of [
			["access_denied", "HOBO_CD_VERCEL_DEVICE_DENIED"],
			["expired_token", "HOBO_CD_VERCEL_DEVICE_EXPIRED"],
		] as const)
			await expect(
				vercelDeviceToken({
					fetch: fakeVercel([reply]).http,
					emit: () => undefined,
					sleep: instant,
				}),
			).rejects.toMatchObject({ code });
	});

	it("does not poll after the device code expires", async () => {
		let time = 0;
		const calls: string[] = [];
		await expect(
			vercelDeviceToken({
				fetch: async (input) => {
					calls.push(String(input));
					return Response.json({
						device_code: "dev-code",
						user_code: "ABCD-EFGH",
						verification_uri: "https://vercel.com/device",
						expires_in: 3,
						interval: 5,
					});
				},
				emit: () => undefined,
				now: () => time,
				sleep: async (ms) => {
					time += ms;
				},
			}),
		).rejects.toMatchObject({ code: "HOBO_CD_VERCEL_DEVICE_EXPIRED" });
		expect(calls).toEqual([VERCEL_DEVICE_AUTHORIZATION_URL]);
		expect(time).toBe(3000);
	});
});

describe("vercelDeviceTeam", () => {
	it("takes the only team, the named one, and refuses to guess among several", async () => {
		expect(await vercelDeviceTeam(TOKEN, undefined, fakeVercel([]).http)).toBe(
			"team_abc",
		);
		const two = fakeVercel(
			[],
			[
				{ id: "team_abc", slug: "acme" },
				{ id: "team_xyz", slug: "other" },
			],
		).http;
		expect(await vercelDeviceTeam(TOKEN, "other", two)).toBe("team_xyz");
		await expect(vercelDeviceTeam(TOKEN, undefined, two)).rejects.toMatchObject(
			{ code: "HOBO_CD_VERCEL_TEAM_AMBIGUOUS" },
		);
	});

	it("follows team pages before selecting a sole team or a named team", async () => {
		const calls: string[] = [];
		const http = async (input: string | URL | Request) => {
			const url = new URL(String(input));
			calls.push(url.toString());
			return url.searchParams.has("until")
				? Response.json({
						teams: [{ id: "team_xyz", slug: "other" }],
						pagination: { next: null },
					})
				: Response.json({
						teams: [{ id: "team_abc", slug: "acme" }],
						pagination: { next: 123 },
					});
		};
		await expect(
			vercelDeviceTeam(TOKEN, undefined, http),
		).rejects.toMatchObject({ code: "HOBO_CD_VERCEL_TEAM_AMBIGUOUS" });
		expect(calls).toEqual([
			"https://api.vercel.com/v2/teams",
			"https://api.vercel.com/v2/teams?until=123",
		]);
		expect(await vercelDeviceTeam(TOKEN, "other", http)).toBe("team_xyz");
	});

	it("fails closed if pagination is missing or repeats a cursor", async () => {
		for (const http of [
			async () => Response.json({ teams: [{ id: "team_abc", slug: "acme" }] }),
			async () =>
				Response.json({
					teams: [{ id: "team_abc", slug: "acme" }],
					pagination: { next: 123 },
				}),
		]) {
			await expect(
				vercelDeviceTeam(TOKEN, undefined, http),
			).rejects.toMatchObject({ code: "HOBO_CD_VERCEL_DEVICE_FAILED" });
		}
	});
});

function handOffInput(lines: string[]): PrepareInput {
	const run: Pick<CommandRunInput, "emitProgress" | "flags"> = {
		emitProgress: (line) => lines.push(line),
		// SAFETY: the preparation fixture reads only these two output flags.
		flags: { json: false, quiet: false } as CommandRunInput["flags"],
	};
	// SAFETY: prepareVercelConnection reads only progress and these output flags.
	return {
		action: "up",
		projectDir: "/tmp/hobo-cd",
		whatIf: false,
		yes: false,
		handOff: true,
		run: run as CommandRunInput,
	};
}

function locator(values: SavedSettings) {
	return { read: async () => values, write: async () => undefined };
}

describe("hobo cd up --hand-off", () => {
	it("connects Vercel with the device grant into a store the egress proxy signs in to, serving no page", async () => {
		const port = createMemorySecretsPort({ id: "memory" });
		const store: OpenedSecretStore = {
			id: "infisical",
			port,
			reference: (name) => `infisical://proj/prod/hobo-cd/${name}`,
		};
		let signIn: string | undefined;
		const lines: string[] = [];
		const { http } = fakeVercel(["ok"]);
		const outcome = await prepareVercelConnection(handOffInput(lines), {
			env: {},
			locator: locator({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "proj",
				INFISICAL_SIGN_IN: "egress-proxy",
			}),
			openStore: async (_id, coordinates): Promise<SecretStoreOpening> => {
				signIn = coordinates.INFISICAL_SIGN_IN;
				return { ok: true, store };
			},
			fetch: http,
			sleep: instant,
			startPage: () => {
				throw new Error("a handed-off run must not serve a page");
			},
		});
		expect(signIn).toBe("egress-proxy");
		expect(outcome.kind).toBe("ready");
		if (outcome.kind !== "ready") throw new Error("not ready");
		expect(outcome.credentials?.reveal("VERCEL_TOKEN")).toBe(TOKEN);
		expect((await port.access("HOBO_CD_VERCEL_INSTALLATION_ID")).material).toBe(
			"device-grant",
		);
		expect((await port.access("HOBO_CD_VERCEL_TEAM_ID")).material).toBe(
			"team_abc",
		);
		expect(lines.join("\n")).not.toContain(TOKEN);
	});

	it("refuses when the store cannot open without a page", async () => {
		const outcome = await prepareVercelConnection(handOffInput([]), {
			env: {},
			locator: locator({
				HOBO_SECRET_STORE: "infisical",
				INFISICAL_PROJECT_ID: "proj",
			}),
			openStore: async () => ({
				ok: false,
				message: "Not signed in to Infisical.",
				remediation: [],
			}),
			sleep: async () => undefined,
			handOffTimeoutMs: 1,
			startPage: () => {
				throw new Error("a handed-off run must not serve a page");
			},
		});
		expect(outcome).toMatchObject({
			kind: "refused",
			result: { code: "HOBO_CD_STORE_NEEDS_SIGN_IN" },
		});
		expect(JSON.stringify(outcome)).toContain(
			"Choose the store and give its non-secret ids",
		);
		expect(JSON.stringify(outcome)).not.toContain("ids are committed");
	});
});
