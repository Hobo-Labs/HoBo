/**
 * L39 / O45: PACT tests of the overlay credential minters.
 *
 * `pacts/` holds the consumer contracts, written from the providers' API
 * reference: they pin what the minters send (single use, the expiry, exactly
 * the tags) and what they read back. `recorded/` holds interactions recorded
 * against a real Tailscale tailnet and a real NetBird account; the `[A13] …`
 * cases replay them and are the only cases that may skip, when no recording
 * has been committed (assumption A13 not tested, fallback taken).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPactDirectory, type PactDocument } from "@hobo/contract-harness";
import { parseTenantId } from "@hobo/core";
import { parseMemberId } from "@hobo/fleet";
import { describe, expect, it } from "vitest";
import {
	createPactFetch,
	requirePact,
} from "../../contracts/helpers/pact-fetch.js";
import {
	createNetbirdCredentialMinter,
	createTailscaleCredentialMinter,
} from "../../src/minters/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const tenant = parseTenantId("acme");
const memberId = parseMemberId("dev_0123456789abcdef0123456789abcdef");
const TEN_MINUTES = 600_000;

const recordedDir = path.join(here, "recorded");
const tailscaleRecorded = path.join(
	recordedDir,
	"tailscale-auth-keys.pact.json",
);
const netbirdRecorded = path.join(recordedDir, "netbird-setup-keys.pact.json");

async function pactFor(dir: string, provider: string): Promise<PactDocument> {
	return requirePact(await loadPactDirectory(dir), provider);
}

describe("TailscaleAuthKeysApi consumer contract", () => {
	it("mints one single-use, pre-authorised, tag-scoped key and returns it as an OverlayJoin", async () => {
		const pact = await pactFor(
			path.join(here, "pacts"),
			"TailscaleAuthKeysApi",
		);
		const minter = createTailscaleCredentialMinter({
			apiBase: "https://api.tailscale.com",
			organisation: "example.com",
			credential: async () => "tskey-api-pact",
			fetch: createPactFetch(pact),
		});
		const outcome = await minter.mint({
			tenant,
			memberId,
			tags: ["tag:fleet-ci"],
			ttlMs: TEN_MINUTES,
		});
		expect(outcome).toEqual({
			ok: true,
			value: {
				$typeName: "hobo.fleet.v1.OverlayJoin",
				provider: "tailscale",
				credential: "tskey-auth-kPACT1CNTRL-pactpactpactpactpactpact",
				expiresAt: "2026-11-13T10:10:00Z",
				tags: ["tag:fleet-ci"],
			},
		});
	});

	it("answers unavailable for a request off the contract (another expiry)", async () => {
		const pact = await pactFor(
			path.join(here, "pacts"),
			"TailscaleAuthKeysApi",
		);
		const minter = createTailscaleCredentialMinter({
			apiBase: "https://api.tailscale.com",
			organisation: "example.com",
			credential: async () => "tskey-api-pact",
			fetch: createPactFetch(pact),
		});
		// A different expiry is a different request: the pact stub answers 404, the minter `unavailable`.
		const outcome = await minter.mint({
			tenant,
			memberId,
			tags: ["tag:fleet-ci"],
			ttlMs: 2 * TEN_MINUTES,
		});
		expect(!outcome.ok && outcome.error.code).toBe("unavailable");
	});
});

describe("NetbirdSetupKeysApi consumer contract", () => {
	it("resolves the tags to groups and mints one one-off setup key", async () => {
		const pact = await pactFor(path.join(here, "pacts"), "NetbirdSetupKeysApi");
		const minter = createNetbirdCredentialMinter({
			apiBase: "https://api.netbird.io",
			organisation: "",
			credential: async () => "nbp_pact",
			fetch: createPactFetch(pact),
		});
		const outcome = await minter.mint({
			tenant,
			memberId,
			tags: ["fleet-ci"],
			ttlMs: TEN_MINUTES,
		});
		expect(outcome).toEqual({
			ok: true,
			value: {
				$typeName: "hobo.fleet.v1.OverlayJoin",
				provider: "netbird",
				credential: "A616097E-FCF0-48FA-9354-CA4A61142761",
				expiresAt: "2026-11-14T10:00:00Z",
				tags: ["fleet-ci"],
			},
		});
	});
});

describe("recorded provider interactions", () => {
	it.skipIf(!existsSync(tailscaleRecorded))(
		"[A13] the Tailscale minter replays the interaction recorded against a real tailnet",
		async () => {
			const pact = await pactFor(recordedDir, "TailscaleAuthKeysApi");
			const minter = createTailscaleCredentialMinter({
				apiBase: "https://api.tailscale.com",
				organisation: "example.com",
				credential: async () => "recorded",
				fetch: createPactFetch(pact),
			});
			const outcome = await minter.mint({
				tenant,
				memberId,
				tags: ["tag:fleet-ci"],
				ttlMs: TEN_MINUTES,
			});
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.value.credential.startsWith("tskey-auth-")).toBe(true);
			expect(Date.parse(outcome.value.expiresAt)).toBeGreaterThan(0);
		},
	);

	it.skipIf(!existsSync(netbirdRecorded))(
		"[A13] the NetBird minter replays the interactions recorded against a real account",
		async () => {
			const pact = await pactFor(recordedDir, "NetbirdSetupKeysApi");
			const minter = createNetbirdCredentialMinter({
				apiBase: "https://api.netbird.io",
				organisation: "",
				credential: async () => "recorded",
				fetch: createPactFetch(pact),
			});
			const outcome = await minter.mint({
				tenant,
				memberId,
				tags: ["fleet-ci"],
				ttlMs: TEN_MINUTES,
			});
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.value.credential.length).toBeGreaterThan(0);
		},
	);
});
