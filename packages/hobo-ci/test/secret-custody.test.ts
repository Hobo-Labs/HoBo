import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	ignoredSecretEnvNotice,
	SECRET_ENV_NAMES,
	secretEnvNames,
	withoutSecretEnv,
} from "../src/secret-custody.js";

const packages = fileURLToPath(new URL("../../", import.meta.url));

/** The lifecycle code that must never read a secret from the environment. */
const LIFECYCLE_SOURCES = [
	"hobo-ci/src",
	"hobo-cd/src",
	"connect-ui/src",
	"hobo/src/cd-store.ts",
	"hobo/src/cd-runtime.ts",
	"hobo/src/ci-relay-deploy.ts",
	"hobo/src/ci-relay-deploy-credential.ts",
	"hobo/src/provider-ceremony.ts",
];

function files(entry: string): string[] {
	const full = path.join(packages, entry);
	if (statSync(full).isFile()) return [full];
	return readdirSync(full, { recursive: true })
		.map((name) => path.join(full, String(name)))
		.filter((name) => /\.tsx?$/u.test(name) && !name.includes("_generated"));
}

describe("secret custody", () => {
	it("names secrets in an environment without their values", () => {
		const env = {
			PATH: "/usr/bin",
			INFISICAL_TOKEN: "tok-value",
			service_credential: "opaque-value",
			HOBO_CD_POSTGRES_URL_NEON: "postgres://u:p@h/db",
			DATABASE_URL: "postgres://u:p@h/db",
			HOBO_CI_PUBLIC_URL: "https://ci.example",
		};
		expect(secretEnvNames(env)).toEqual([
			"DATABASE_URL",
			"HOBO_CD_POSTGRES_URL_NEON",
			"INFISICAL_TOKEN",
			"service_credential",
		]);
		expect(withoutSecretEnv(env)).toEqual({
			PATH: "/usr/bin",
			HOBO_CI_PUBLIC_URL: "https://ci.example",
		});
		const notice = ignoredSecretEnvNotice(env) ?? "";
		expect(notice).toContain("INFISICAL_TOKEN");
		expect(notice).not.toContain("tok-value");
	});

	it("no lifecycle source reads a secret from the environment", () => {
		const offenders: string[] = [];
		const read =
			/\benv(?:\??\.)\s*([A-Z][A-Z0-9_]*)|\benv\[\s*"([A-Z][A-Z0-9_]*)"\s*\]/gu;
		for (const entry of LIFECYCLE_SOURCES)
			for (const file of files(entry)) {
				const text = readFileSync(file, "utf8");
				for (const match of text.matchAll(read)) {
					const name = match[1] ?? match[2] ?? "";
					if (
						SECRET_ENV_NAMES.has(name) ||
						name.startsWith("HOBO_CD_POSTGRES_URL_")
					)
						offenders.push(`${path.relative(packages, file)}: ${name}`);
				}
			}
		expect(offenders).toEqual([]);
	});
});
