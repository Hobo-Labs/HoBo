import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

	it("fixture documents the snake_case durable record shape", () => {
		const fixture = JSON.parse(
			readFileSync(join(here, "fixtures", "plan-record.json"), "utf8"),
		);
		expect(fixture.claims_mapping_version).toBe("better-auth-claims/v1");
		expect(fixture.parsed_config.database_profile).toBe("data.relational/v1");
		expect(fixture.ports.relational_bindle).toBe("auth_db");
	});

	it("validates migration record profiles against the supported versions", () => {
		const scratch = mkdtempSync(
			join(tmpdir(), "hobo-pack-better-auth-migration-"),
		);
		try {
			const dataFile = join(scratch, "migration.json");
			for (const [profile, valid] of [
				["data.relational/v1", true],
				["data.postgres/v1", true],
				["data.relational/v2", false],
				["data.postgres/v0", false],
			] as const) {
				writeFileSync(
					dataFile,
					JSON.stringify({
						pack_id: "pack.better-auth/v1",
						relational_bindle: "auth_db",
						database_profile: profile,
						migration_plan_contract: "hobo.migration-plan/v1",
						migration_plan_digest: `sha256:${"a".repeat(64)}`,
						expand_step_count: 1,
					}),
				);
				const result = spawnSync(
					cueBin,
					[
						"vet",
						"-c",
						"-d",
						"#BetterAuthRelationalMigrationRecord",
						"pack_better_auth.cue",
						dataFile,
					],
					{ cwd: dataModels, encoding: "utf8" },
				);
				if (result.error) throw result.error;
				expect(result.status === 0, profile).toBe(valid);
			}
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});
