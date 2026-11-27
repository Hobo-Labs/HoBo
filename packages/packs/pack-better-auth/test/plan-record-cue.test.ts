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
} as const;

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
});
