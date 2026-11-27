import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	createCapabilityProfileRegistry,
	STANDARD_CAPABILITY_PROFILES,
} from "@hobo/capability-profiles";
import { describe, expect, it } from "vitest";
import {
	planBetterAuthBundle,
	toBetterAuthBundlePlanRecord,
} from "../src/index.js";
import { cueBinary } from "./helpers/cue-binary.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..", "..");
const dataModels = join(here, "..", "data-models");
const cueBin = cueBinary(process.env, repoRoot);

const CONFIG_INPUT = {
	basePath: "/api/auth",
	secretRef: "hobo-secret://camp-prod/auth/better-auth-signing-key",
	database: { profile: "data.relational/v1" },
	emailAndPassword: { enabled: true },
	socialProviders: ["github", "google"],
	organizations: { enabled: true },
};

const PORTS = {
	relationalBindle: "auth_db",
	httpBindle: "auth_api",
	signingSecretRef: CONFIG_INPUT.secretRef,
} as const;

describe("BetterAuthBundlePlanRecord CUE", () => {
	it("vets a real planBetterAuthBundle record against pack_better_auth.cue", () => {
		const plan = planBetterAuthBundle(CONFIG_INPUT, PORTS);
		const record = toBetterAuthBundlePlanRecord(plan);
		expect(record.parsed_config.social_providers).toEqual(["github", "google"]);
		expect(record.parsed_config.email_and_password_enabled).toBe(true);
		const scratch = mkdtempSync(join(tmpdir(), "hobo-pack-better-auth-cue-"));
		try {
			const dataFile = join(scratch, "plan.json");
			writeFileSync(dataFile, JSON.stringify(record));
			const result = spawnSync(
				cueBin,
				[
					"vet",
					"-c",
					"-d",
					"#BetterAuthBundlePlanRecord",
					"pack_better_auth.cue",
					dataFile,
				],
				{ cwd: dataModels, encoding: "utf8" },
			);
			if (result.error) {
				throw result.error;
			}
			expect(`${result.stdout}${result.stderr}`).toBe("");
			expect(result.status).toBe(0);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("rejects malformed and internally inconsistent replay records", () => {
		const valid = toBetterAuthBundlePlanRecord(
			planBetterAuthBundle(CONFIG_INPUT, PORTS),
		);
		const queryLocator = "hobo-secret://camp-prod/auth/key?version=2";
		const records = [
			{
				...valid,
				parsed_config: {
					...valid.parsed_config,
					database_profile: "data.mongodb/v1",
				},
			},
			{
				...valid,
				parsed_config: { ...valid.parsed_config, secret_ref: queryLocator },
				ports: { ...valid.ports, signing_secret_ref: queryLocator },
			},
			{
				...valid,
				ports: {
					...valid.ports,
					signing_secret_ref: "hobo-secret://camp-prod/auth/other",
				},
			},
			...[
				"vault://camp-prod/auth/../key",
				"aws-sm://camp-prod/auth/key#field",
				`hobo-secret://camp-prod/${"x".repeat(2049)}`,
			].map((locator) => ({
				...valid,
				parsed_config: { ...valid.parsed_config, secret_ref: locator },
				ports: { ...valid.ports, signing_secret_ref: locator },
			})),
			{ ...valid, base_path: "/api/other" },
			{ ...valid, route_pattern: "/api/other/*" },
		];
		const scratch = mkdtempSync(
			join(tmpdir(), "hobo-pack-better-auth-cue-invalid-"),
		);
		try {
			for (const [index, record] of records.entries()) {
				const dataFile = join(scratch, `invalid-${index}.json`);
				writeFileSync(dataFile, JSON.stringify(record));
				const result = spawnSync(
					cueBin,
					[
						"vet",
						"-c",
						"-d",
						"#BetterAuthBundlePlanRecord",
						"pack_better_auth.cue",
						dataFile,
					],
					{ cwd: dataModels, encoding: "utf8" },
				);
				if (result.error) throw result.error;
				expect(result.status, `invalid record ${index} was accepted`).not.toBe(
					0,
				);
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("keeps both replay schemas aligned with registered relational profiles", () => {
		const registry = createCapabilityProfileRegistry(
			STANDARD_CAPABILITY_PROFILES,
		);
		const profiles = registry
			.list()
			.filter((profile) =>
				registry.satisfies(profile.id, "data.relational/v1"),
			);
		expect(profiles.length).toBeGreaterThan(0);
		const scratch = mkdtempSync(join(tmpdir(), "hobo-auth-profile-cue-"));
		try {
			for (const profile of profiles) {
				const record = toBetterAuthBundlePlanRecord(
					planBetterAuthBundle(
						{ ...CONFIG_INPUT, database: { profile: profile.id } },
						PORTS,
					),
				);
				const packFile = join(scratch, "pack.json");
				const contractFile = join(scratch, "contract.json");
				writeFileSync(packFile, JSON.stringify(record));
				writeFileSync(contractFile, JSON.stringify(record.parsed_config));
				for (const [cwd, model, definition, data] of [
					[
						dataModels,
						"pack_better_auth.cue",
						"#BetterAuthBundlePlanRecord",
						packFile,
					],
					[
						join(repoRoot, "packages/auth-adapter-contract/data-models"),
						"auth_adapter_contract.cue",
						"#BetterAuthConfigRecord",
						contractFile,
					],
				] as const) {
					const result = spawnSync(
						cueBin,
						["vet", "-c", "-d", definition, model, data],
						{ cwd, encoding: "utf8" },
					);
					if (result.error) throw result.error;
					expect(result.status, `${profile.id}: ${result.stderr}`).toBe(0);
				}
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("fixture documents the snake_case durable record shape", () => {
		const fixture = JSON.parse(
			readFileSync(join(here, "fixtures", "plan-record.json"), "utf8"),
		);
		expect(fixture.claims_mapping_version).toBe("better-auth-claims/v1");
		expect(fixture.parsed_config.database_profile).toBe("data.relational/v1");
		expect(fixture.ports.relational_bindle).toBe("auth_db");
	});
});
