import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseVercelGitEnvironment } from "../src/git-deployment-environment.js";

const expected = {
	teamId: "team_123",
	projectId: "prj_123",
	revision: "0123456789abcdef0123456789abcdef01234567",
};
function fixture() {
	const consumer = {
		yard: "cd",
		camp: "production",
		provider: "vercel",
		accountId: expected.teamId,
	};
	const makeScope = (
		junction: string,
		provider: string,
		capability: string,
	) => ({
		deploymentId: "deploy",
		revision: expected.revision,
		junction,
		edge: `cd->${junction}`,
		tier: "public-authenticated-tls",
		consumer,
		producer: {
			yard: junction,
			camp: "production",
			provider,
			accountId: `${provider}-account`,
		},
		capability,
		resourceId: "resource",
	});
	const config = makeScope(
		"config",
		"infisical",
		"secret-ref.dynamic-resolution/v1",
	);
	const key = generateKeyPairSync("ed25519")
		.publicKey.export({ type: "spki", format: "pem" })
		.toString();
	const context = {
		contract: "hobo.cd-host-context/v1",
		deploymentId: "deploy",
		revision: expected.revision,
		tenant: "tenant",
		station: "station",
		controlSecretRef: "infisical://project/prod/cd/CONTROL",
		vercelProjectId: expected.projectId,
		projectionPointers: {
			storeId: "store_123",
			journalScope: "journal",
			artifactsScope: "artifacts",
			configScope: "config",
		},
		journal: makeScope("journal", "neon", "data.postgres/v1"),
		artifacts: makeScope("artifacts", "aws", "bucket.s3-compatible/v1"),
		config,
		trustedKeys: [{ id: "supervisor", publicKey: key }],
		hostingHealth: {
			planHash: `sha256:${"a".repeat(64)}`,
			capabilityDigest: "capabilities:v1",
			jurisdiction: "US",
		},
	};
	const evidence = {
		digest: `sha256:${"b".repeat(64)}`,
		observedAtMs: 10,
		expiresAtMs: 1000,
	};
	const projection = {
		keyId: "supervisor",
		signature: "A".repeat(86),
		payload: {
			contract: "hobo.junction-projection/v1",
			...config,
			binding: {
				kind: "infisical",
				endpoint: "https://app.infisical.com",
				projectId: "project",
				environment: "prod",
				folder: "/cd",
				identityId: "identity",
				issuer: "https://oidc.vercel.com/team",
				subject: "owner:team:project:cd:environment:production",
				audience: "https://vercel.com/team",
				claims: { owner_id: expected.teamId, project_id: expected.projectId },
				tls: "verify-full",
			},
			producerEvidence: evidence,
			consumerEvidence: evidence,
			issuedAtMs: 11,
			expiresAtMs: 100,
		},
	};
	const vars = [
		{ name: "HOBO_CD_HOST_CONTEXT", value: JSON.stringify(context) },
		{ name: "HOBO_CD_CONFIG_PROJECTION", value: JSON.stringify(projection) },
		{ name: "BLOB_STORE_ID", value: "store_123" },
		{ name: "INFISICAL_SITE_URL", value: "https://app.infisical.com" },
		{ name: "INFISICAL_PROJECT_ID", value: "project" },
		{ name: "INFISICAL_ENVIRONMENT", value: "prod" },
		{ name: "INFISICAL_SECRET_PATH", value: "/cd" },
		{ name: "INFISICAL_IDENTITY_ID", value: "identity" },
	];
	return { vars, context, projection };
}
describe("Vercel public deployment environment parsing", () => {
	it("accepts a complete scoped CD bootstrap and returns canonical name ordering", () => {
		const f = fixture();
		const parsed = parseVercelGitEnvironment(f.vars, expected);
		expect(parsed.map((v) => v.name)).toEqual(parsed.map((v) => v.name).sort());
		expect(parsed).toHaveLength(8);
		expect(() =>
			parseVercelGitEnvironment(f.vars, { ...expected, projectId: "wrong" }),
		).toThrow();
	});
	it("accepts a separate renewable config pointer and rejects overlapping or invalid scopes", () => {
		const f = fixture();
		const vars = (configScope: string) =>
			f.vars.map((row) =>
				row.name === "HOBO_CD_HOST_CONTEXT"
					? {
							...row,
							value: JSON.stringify({
								...f.context,
								projectionPointers: {
									...f.context.projectionPointers,
									configScope,
								},
							}),
						}
					: row,
			);
		expect(parseVercelGitEnvironment(vars("config"), expected)).toHaveLength(8);
		for (const scope of ["journal", "artifacts", "Bearer secret"])
			expect(() => parseVercelGitEnvironment(vars(scope), expected)).toThrow();
	});
	it("rejects hidden credential fields and values, foreign scopes, and inconsistent coordinates", () => {
		const f = fixture();
		const replace = (name: string, value: string) =>
			f.vars.map((row) => (row.name === name ? { name, value } : row));
		for (const bad of [
			replace(
				"HOBO_CD_HOST_CONTEXT",
				JSON.stringify({
					...f.context,
					projectionPointers: {
						storeId: "store_123",
						journalScope: "journal",
						artifactsScope: "artifacts",
					},
				}),
			),
			replace(
				"HOBO_CD_HOST_CONTEXT",
				JSON.stringify({ ...f.context, privateKey: "not-public" }),
			),
			replace(
				"HOBO_CD_HOST_CONTEXT",
				JSON.stringify({
					...f.context,
					controlSecretRef: "Bearer private-token",
				}),
			),
			replace(
				"HOBO_CD_HOST_CONTEXT",
				JSON.stringify({ ...f.context, vercelProjectId: "prj_other" }),
			),
			replace(
				"HOBO_CD_CONFIG_PROJECTION",
				JSON.stringify({
					...f.projection,
					payload: { ...f.projection.payload, password: "secret" },
				}),
			),
			replace("INFISICAL_SITE_URL", "https://user:secret@app.infisical.com"),
			replace("BLOB_STORE_ID", "store_other"),
			[...f.vars, { name: "CRON_SECRET", value: "private" }],
			[...f.vars, f.vars[0]],
		])
			expect(() => parseVercelGitEnvironment(bad, expected)).toThrow(
				/unapproved or invalid/u,
			);
	});
	it("accepts bounded, unique ordered CI fleet names only", () => {
		expect(
			parseVercelGitEnvironment(
				[
					{
						name: "HOBO_CI_CACHE_MEMBERS",
						value: '["blob","supabase-postgres","upstash-blob"]',
					},
					{ name: "HOBO_CI_CACHE_QUORUM", value: "2" },
				],
				expected,
			),
		).toHaveLength(2);
		for (const value of [
			'["blob","blob"]',
			'["bogus"]',
			"blob,turso",
			'["secret"]',
		])
			expect(() =>
				parseVercelGitEnvironment(
					[{ name: "HOBO_CI_CACHE_MEMBERS", value }],
					expected,
				),
			).toThrow();
		expect(() =>
			parseVercelGitEnvironment(
				[
					{
						name: "HOBO_CI_CACHE_MEMBERS",
						value: '["blob","cloudflare-d1","turso"]',
					},
					{ name: "HOBO_CI_CACHE_QUORUM", value: "1" },
				],
				expected,
			),
		).toThrow();
	});
});
