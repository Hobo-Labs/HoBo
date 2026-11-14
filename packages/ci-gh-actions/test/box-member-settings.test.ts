import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
	BOX_MEMBER_PROCESS_PATHS,
	readBoxMemberSettings,
} from "../src/isolated-worker/box-member-settings.js";
import { CiProjectDocumentSchema } from "../src/project-schema.js";

/**
 * D61: a box's fleet settings are committed configuration (the `fleet` block
 * of `.hobo/ci.json`, beside `runnerRouting`), never environment variables.
 * Only a file path to the agent's state or its bootstrap token comes from the
 * process.
 */
/** domain-view: the part of `.hobo/ci.json` these tests write, valid or not. */
type ProjectDocument = Readonly<{
	defaultEnvironment?: string;
	fleet?: Readonly<
		Record<string, string | Readonly<Record<string, string | boolean>>>
	>;
}>;

function checkout(document: ProjectDocument | undefined) {
	const root = mkdtempSync(join(tmpdir(), "hobo-box-member-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, ".hobo"));
	if (document !== undefined)
		writeFileSync(join(root, ".hobo", "ci.json"), JSON.stringify(document));
	return root;
}

const FLEET = {
	authorityUrl: "https://fleet.example.test",
	fleet: "hobo",
	tenant: "hobo-labs",
	region: "eu-west",
};

describe("the box's committed fleet settings", () => {
	it("are absent without a fleet block or a file: the box runs alone", () => {
		expect(readBoxMemberSettings(checkout(undefined), {})).toBeUndefined();
		expect(
			readBoxMemberSettings(checkout({ defaultEnvironment: "ci" }), {}),
		).toBeUndefined();
	});

	it("read the fleet block, with paths from the process and defaults beside the journal", () => {
		const root = checkout({ fleet: FLEET });
		expect(
			readBoxMemberSettings(root, {}, { journalDirectory: "/var/lib/hobo" }),
		).toEqual({
			...FLEET,
			memberName: undefined,
			sandbox: { runtime: undefined, cache: undefined, download: true },
			home: "/var/lib/hobo/fleet-member",
			bootstrapTokenFile: undefined,
		});
		expect(
			readBoxMemberSettings(
				root,
				{
					HOBO_FLEET_HOME: "/srv/member",
					HOBO_FLEET_BOOTSTRAP_TOKEN_FILE: "/run/secrets/fleet-token",
				},
				{ journalDirectory: "/var/lib/hobo" },
			),
		).toMatchObject({
			home: "/srv/member",
			bootstrapTokenFile: "/run/secrets/fleet-token",
		});
	});

	it("never take a fleet setting from the environment", () => {
		const root = checkout({ fleet: FLEET });
		const settings = readBoxMemberSettings(root, {
			HOBO_FLEET_AUTHORITY_URL: "https://elsewhere.example.test",
			HOBO_FLEET_NAME: "other",
			HOBO_FLEET_TENANT: "other",
			HOBO_FLEET_REGION: "other",
			HOBO_FLEET_MEMBER_NAME: "other",
			HOBO_FLEET_SANDBOX_RUNTIME: "/usr/bin/runc",
		});
		expect(settings).toMatchObject({
			...FLEET,
			memberName: undefined,
			sandbox: { runtime: undefined },
		});
		expect(BOX_MEMBER_PROCESS_PATHS).toEqual([
			"HOBO_FLEET_HOME",
			"HOBO_FLEET_BOOTSTRAP_TOKEN_FILE",
		]);
	});

	it("take the sandbox settings (D58) from the block", () => {
		const settings = readBoxMemberSettings(
			checkout({
				fleet: {
					...FLEET,
					memberName: "box-1",
					sandbox: {
						runtime: "/opt/runsc",
						cache: "/var/cache/fleet",
						download: false,
					},
				},
			}),
			{},
		);
		expect(settings?.memberName).toBe("box-1");
		expect(settings?.sandbox).toEqual({
			runtime: "/opt/runsc",
			cache: "/var/cache/fleet",
			download: false,
		});
	});

	it("refuse to start on a block that is not a fleet setting", () => {
		for (const fleet of [
			{ ...FLEET, authorityUrl: "http://fleet.example.test" },
			{ ...FLEET, fleet: "Not A Name" },
			{ ...FLEET, token: "hft_secret" },
			{ ...FLEET, sandbox: { runtime: "runsc" } },
		])
			expect(() => readBoxMemberSettings(checkout({ fleet }), {})).toThrow(
				/invalid fleet in \.hobo\/ci\.json/u,
			);
	});

	it("are part of the committed project schema", () => {
		expect(CiProjectDocumentSchema.safeParse({ fleet: FLEET }).success).toBe(
			true,
		);
		expect(
			CiProjectDocumentSchema.safeParse({
				fleet: { ...FLEET, bootstrapToken: "hft_x" },
			}).success,
		).toBe(false);
	});
});
