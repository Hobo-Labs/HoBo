import { afterEach, describe, expect, it } from "vitest";

import {
	type InfisicalAccess,
	lazyEgressFetch,
	provisionInfisicalAccess,
	type RunCommand,
} from "../../src/index.js";
import {
	copiedSession,
	startFakeInfisical,
} from "../support/fake-infisical.js";
import {
	driveRemoteOwner,
	heldOwnerChannel,
	readOwnerTurn,
	startForwardProxy,
} from "../support/remote-owner.js";

// SPEC: the Infisical ceremony from a remote dev box, step by step, with a
// failure injected at each step. The owner is simulated as they really are
// (see support/remote-owner.ts): a browser on their own device and the
// agent's chat, never the box's terminal or 127.0.0.1. Infisical is a real
// HTTP server and every API call goes through a real forward proxy, as the
// box's network requires. A scenario passes only if the owner reaches a
// ready store, or gets a refusal whose every line they can act on.

type Fake = Awaited<ReturnType<typeof startFakeInfisical>>;
type Proxy = Awaited<ReturnType<typeof startForwardProxy>>;
const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
	await Promise.all(open.splice(0).map((server) => server.close()));
});

async function remoteBox(options: { proxyCredentials?: string } = {}) {
	const infisical = await startFakeInfisical();
	const proxy = await startForwardProxy({
		...(options.proxyCredentials !== undefined
			? { credentials: options.proxyCredentials }
			: undefined),
		onTunnel: (port) => infisical.tunnelled.add(port),
	});
	open.push(infisical, proxy);
	return { infisical, proxy };
}

/** A box with no Infisical CLI. */
const noCli: RunCommand = async () => ({ code: 127, stdout: "", stderr: "" });

function provisioner(
	infisical: Fake,
	proxy: Proxy,
	options: {
		readonly owner?: ReturnType<typeof heldOwnerChannel>;
		readonly run?: RunCommand;
		readonly cliOnPath?: boolean;
		readonly proxyAuth?: string;
	} = {},
) {
	const env = { HTTPS_PROXY: proxy.url(options.proxyAuth), NO_PROXY: "" };
	return () =>
		provisionInfisicalAccess({
			family: "cd",
			projectId: "proj-1",
			run: options.run ?? noCli,
			which: async (bin) => (options.cliOnPath === true ? bin : undefined),
			toolsDir: "/unused",
			// What prepare hands it: the environment's egress, read up front.
			fetch: lazyEgressFetch(env),
			emit: () => undefined,
			interactive: false,
			apiOrigin: infisical.origin,
			exists: () => false,
			sleep: async () => undefined,
			...(options.owner !== undefined ? { owner: options.owner } : undefined),
		});
}

const turn = (access: InfisicalAccess) => ({
	ready: access.kind === "ready",
	lines:
		access.kind === "ready"
			? []
			: [access.code, access.message, ...access.remediation],
});

/** The owner signs in on their own device and hands the copied session over. */
const signsIn =
	(infisical: Fake, owner: ReturnType<typeof heldOwnerChannel>) =>
	async (_url: URL, capture: string) => {
		owner.deposit(capture, copiedSession(infisical.signIn()));
	};

describe("SPEC remote Infisical: sign-in", () => {
	it("happy path: one sign-in link, one hand-over, then ready, every call through the proxy", async () => {
		const { infisical, proxy } = await remoteBox();
		const owner = heldOwnerChannel();
		const provision = provisioner(infisical, proxy, { owner });
		const result = await driveRemoteOwner({
			run: async () => turn(await provision()),
			publicOrigins: [infisical.origin],
			hands: { signIn: signsIn(infisical, owner) },
		});
		expect(result).toMatchObject({ kind: "ready", trail: ["sign-in"] });
		// The box reaches Infisical only through its proxy.
		expect(infisical.calls.length).toBeGreaterThan(0);
		expect(proxy.seen.length).toBeGreaterThan(0);
		expect(infisical.direct()).toBe(0);
	});

	it("the owner pastes the wrong thing: the refusal offers the sign-in link again", async () => {
		const { infisical, proxy } = await remoteBox();
		const owner = heldOwnerChannel();
		const provision = provisioner(infisical, proxy, { owner });
		let pastes = 0;
		const result = await driveRemoteOwner({
			run: async () => turn(await provision()),
			publicOrigins: [infisical.origin],
			hands: {
				signIn: async (url, capture) => {
					pastes += 1;
					if (pastes === 1) owner.deposit(capture, "bm90IGEgc2Vzc2lvbg==");
					else await signsIn(infisical, owner)(url, capture);
				},
			},
		});
		expect(result).toMatchObject({
			kind: "ready",
			trail: ["sign-in", "sign-in"],
		});
	});

	it("the MCP server restarts between the hand-over and the run: the owner is asked again, not stranded", async () => {
		const { infisical, proxy } = await remoteBox();
		const owner = heldOwnerChannel();
		const provision = provisioner(infisical, proxy, { owner });
		let restarts = 0;
		const result = await driveRemoteOwner({
			run: async () => turn(await provision()),
			publicOrigins: [infisical.origin],
			hands: {
				signIn: async (url, capture) => {
					await signsIn(infisical, owner)(url, capture);
					if (restarts === 0) {
						restarts += 1;
						owner.restart();
					}
				},
			},
		});
		expect(result).toMatchObject({ kind: "ready" });
	});

	it("the owner has not answered yet: every run still carries the link, never a dead end", async () => {
		const { infisical, proxy } = await remoteBox();
		const provision = provisioner(infisical, proxy, {
			owner: heldOwnerChannel(),
		});
		for (let run = 0; run < 3; run += 1) {
			const step = readOwnerTurn(false, turn(await provision()).lines, [
				infisical.origin,
			]);
			expect(step).toMatchObject({ kind: "act", action: { kind: "sign-in" } });
		}
	});

	it("the sign-in link is Infisical's own https page, never this box", async () => {
		const { infisical, proxy } = await remoteBox();
		const access = await provisioner(infisical, proxy, {
			owner: heldOwnerChannel(),
		})();
		const step = readOwnerTurn(false, turn(access).lines, [infisical.origin]);
		expect(step).toMatchObject({ kind: "act", action: { kind: "sign-in" } });
	});

	it("an existing CLI session on the box that has expired falls through to the remote sign-in", async () => {
		const { infisical, proxy } = await remoteBox();
		const stale = infisical.signIn();
		infisical.expireAll();
		const owner = heldOwnerChannel();
		const cli: RunCommand = async (_bin, args) =>
			args.join(" ") === "login status"
				? { code: 0, stdout: "logged in", stderr: "" }
				: { code: 0, stdout: stale, stderr: "" };
		const provision = provisioner(infisical, proxy, {
			owner,
			run: cli,
			cliOnPath: true,
		});
		const result = await driveRemoteOwner({
			run: async () => turn(await provision()),
			publicOrigins: [infisical.origin],
			hands: { signIn: signsIn(infisical, owner) },
		});
		expect(result).toMatchObject({ kind: "ready" });
	});

	it("the session expires after the hand-over: the refusal registers its new link, so the next form follows it", async () => {
		// Found by the ceremony explorer: the expired-session refusal named a
		// link but never registered it, so the next capture showed the paste
		// form with no link before it.
		const { infisical, proxy } = await remoteBox();
		const owner = heldOwnerChannel();
		const provision = provisioner(infisical, proxy, { owner });
		owner.deposit("INFISICAL_CLI_SESSION", copiedSession(infisical.signIn()));
		infisical.expireAll();
		const access = await provision();
		expect(access).toMatchObject({ kind: "refused" });
		const step = readOwnerTurn(false, turn(access).lines, [infisical.origin]);
		expect(step).toMatchObject({ kind: "act", action: { kind: "sign-in" } });
		const shown =
			step.kind === "act" && step.action.kind === "sign-in"
				? step.action.url
				: undefined;
		const registered = owner.opened.at(-1);
		expect(registered?.capture).toBe("INFISICAL_CLI_SESSION");
		const link = new URL(registered?.url ?? "");
		expect(`${link.pathname}${link.search}`).toBe(
			`${shown?.pathname}${shown?.search}`,
		);
	});

	it("the session expires between the hand-over and the API calls: a new link, not a permissions error", async () => {
		const { infisical, proxy } = await remoteBox();
		const owner = heldOwnerChannel();
		const provision = provisioner(infisical, proxy, { owner });
		let signIns = 0;
		const result = await driveRemoteOwner({
			run: async () => turn(await provision()),
			publicOrigins: [infisical.origin],
			hands: {
				signIn: async (url, capture) => {
					signIns += 1;
					await signsIn(infisical, owner)(url, capture);
					if (signIns === 1) infisical.expireAll();
				},
			},
		});
		expect(result).toMatchObject({
			kind: "ready",
			trail: ["sign-in", "sign-in"],
		});
	});
});

describe("SPEC remote Infisical: the API through the box's proxy", () => {
	it("a proxy that requires credentials, given them in its URL", async () => {
		const { infisical, proxy } = await remoteBox({
			proxyCredentials: "corp:pass",
		});
		const owner = heldOwnerChannel();
		const provision = provisioner(infisical, proxy, {
			owner,
			proxyAuth: "corp:pass",
		});
		const result = await driveRemoteOwner({
			run: async () => turn(await provision()),
			publicOrigins: [infisical.origin],
			hands: { signIn: signsIn(infisical, owner) },
		});
		expect(result).toMatchObject({ kind: "ready" });
	});

	it("a proxy that rejects the run (407) is named as the proxy, never thrown, never blamed on Infisical", async () => {
		const { infisical, proxy } = await remoteBox({
			proxyCredentials: "corp:pass",
		});
		const owner = heldOwnerChannel();
		owner.deposit("INFISICAL_CLI_SESSION", copiedSession(infisical.signIn()));
		const access = await provisioner(infisical, proxy, { owner })();
		expect(access).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_INFISICAL_EGRESS",
		});
		expect(JSON.stringify(access)).toMatch(/proxy/iu);
		expect(JSON.stringify(access)).toMatch(/407/u);
	});

	it("a dropped connection and 5xx answers are retried within the run", async () => {
		const { infisical, proxy } = await remoteBox();
		infisical.fail("create-identity", 0, 503);
		infisical.fail("add-membership", 502);
		const owner = heldOwnerChannel();
		const provision = provisioner(infisical, proxy, { owner });
		const result = await driveRemoteOwner({
			run: async () => turn(await provision()),
			publicOrigins: [infisical.origin],
			hands: { signIn: signsIn(infisical, owner) },
		});
		expect(result).toMatchObject({ kind: "ready", trail: ["sign-in"] });
	});

	it("an outage that outlasts the retries refuses with 'run again', and the next runs finish without duplicates", async () => {
		const { infisical, proxy } = await remoteBox();
		// The identity is created, then the membership keeps failing.
		infisical.fail("add-membership", 503, 503, 503, 503, 503);
		const owner = heldOwnerChannel();
		const provision = provisioner(infisical, proxy, { owner });
		const result = await driveRemoteOwner({
			run: async () => turn(await provision()),
			publicOrigins: [infisical.origin],
			hands: { signIn: signsIn(infisical, owner) },
		});
		expect(result).toMatchObject({ kind: "ready" });
		// The identity the failed run created is reused, not created twice.
		expect(infisical.identities.size).toBe(1);
		expect([...infisical.identities.values()][0]?.authMethods).toEqual([
			"token-auth",
		]);
	});

	it("a run that already provisioned reuses the identity, its auth and its membership", async () => {
		const { infisical, proxy } = await remoteBox();
		const owner = heldOwnerChannel();
		const provision = provisioner(infisical, proxy, { owner });
		for (let round = 0; round < 2; round += 1) {
			const result = await driveRemoteOwner({
				run: async () => turn(await provision()),
				publicOrigins: [infisical.origin],
				hands: { signIn: signsIn(infisical, owner) },
			});
			expect(result).toMatchObject({ kind: "ready" });
		}
		expect(infisical.identities.size).toBe(1);
	});

	it("an account without the right to manage identities (403) is told what to change, in Infisical's web app", async () => {
		const { infisical, proxy } = await remoteBox();
		infisical.fail("create-identity", 403);
		const owner = heldOwnerChannel();
		owner.deposit("INFISICAL_CLI_SESSION", copiedSession(infisical.signIn()));
		const access = await provisioner(infisical, proxy, { owner })();
		expect(access).toMatchObject({
			kind: "refused",
			code: "HOBO_CD_INFISICAL_API",
		});
		const text = JSON.stringify(access);
		expect(text).toMatch(/403/u);
		expect(text).toMatch(/Admin/u);
		expect(text).toContain(infisical.origin);
		expect(
			readOwnerTurn(false, turn(access).lines, [infisical.origin]).kind,
		).not.toBe("dead-end");
	});
});
