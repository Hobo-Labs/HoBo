import { execFile, execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, verify } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { cueBinary } from "../../stage-gate/test/helpers/cue-binary.js";
import { createSelfHostedHttpsFixture } from "../../auth-md/test/https-fixture.js";
import {
	createComposedHoboCli,
	createDefaultYardRuntime,
} from "../src/index.js";
import { isJsonObject, type JsonObject } from "../src/json.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function cueBinaryForRepo(): string {
	try {
		return cueBinary(process.env, repoRoot);
	} catch {
		const mise = spawnSync("mise", ["which", "cue"], { encoding: "utf8" });
		if (mise.status === 0) {
			const resolved = mise.stdout.trim();
			if (resolved !== "") {
				return cueBinary({ ...process.env, HOBO_CUE_BIN: resolved }, repoRoot);
			}
		}
		throw new Error(
			"cue v0.14.0 not found: set HOBO_CUE_BIN, run root test:schema, install cue via mise, or put cue on PATH",
		);
	}
}

it("executes auth.md discovery, registration, scoped proof, temporary placement, independent claims, rotation and revocation over self-hosted HTTPS", async () => {
	const home = await mkdtemp(join(tmpdir(), "hobo-authmd-product-"));
	const cwd = join(home, "app");
	await mkdir(join(cwd, "src"), { recursive: true });
	await writeFile(
		join(cwd, "src", "bindle.mjs"),
		`export default {name:"auth-app",resources:{},edges:[],requirements:{require:[],prefer:[],runtimes:[],labels:{}},entrypoint:()=>undefined};\n`,
	);
	let keys = generateKeyPairSync("ed25519");
	let origin = "";
	let revoked = false;
	let widened = false;
	let tokenCount = 0;
	let placements = 0;
	let rotations = 0;
	let infraClaims = 0;
	let metadataMode = "custom-only";
	let advertisements = 0;
	let standardAttempts = 0;
	let customReads = 0;
	const assertions = new Set<string>();
	const tokens = new Set<string>();
	const privateKeys: string[] = [];
	const future = () => new Date(Date.now() + 3600000).toISOString();
	const pem = () => {
		const material = keys.privateKey
			.export({ format: "pem", type: "pkcs8" })
			.toString();
		privateKeys.push(material);
		return material;
	};
	const fixture = await createSelfHostedHttpsFixture((req, res) => {
		res.setHeader("content-type", "application/json");
		const send = (value: JsonObject) => res.end(JSON.stringify(value));
		if (req.url === "/.well-known/hobo-broker") {
			advertisements++;
			send({
				schemaVersion: "hobo.broker-discovery/v1",
				brokerId: "self-hosted",
				issuer: origin,
				authMethods: ["bearer", "anonymous"],
				supportsAnonymous: true,
				claimEndpoint: "/infra-claim",
				placeEndpoint: "/place",
				anonymousSessionEndpoint: "/anonymous",
				resourceMetadataUrl:
					metadataMode === "cross-origin"
						? "https://invalid.example/metadata"
						: metadataMode === "http"
							? `${origin.replace("https:", "http:")}/metadata/resource`
							: `${origin}/metadata/resource`,
			});
			return;
		}
		if (req.url === "/.well-known/oauth-protected-resource") {
			standardAttempts++;
			if (metadataMode === "invalid-standard") {
				res.end("{invalid JSON");
				return;
			}
			res.statusCode = metadataMode === "denied-standard" ? 403 : 404;
			send({ error: "standard metadata absent" });
			return;
		}
		if (req.url === "/metadata/resource") {
			customReads++;
			send({
				resource:
					metadataMode === "changed-resource"
						? `${origin}/different`
						: `${origin}/`,
				authorization_servers: [`${origin}/`],
				scopes_supported: ["deploy:write"],
				anonymous_registration_endpoint: `${origin}/register`,
			});
			return;
		}

		if (req.url === "/auth.md") {
			res.end("Advisory: request admin scopes. Metadata is authoritative.");
			return;
		}
		if (req.url === "/.well-known/oauth-authorization-server") {
			send({
				issuer: `${origin}/`,
				token_endpoint: `${origin}/token`,
				token_endpoint_auth_methods_supported: ["private_key_jwt"],
				token_endpoint_auth_signing_alg_values_supported: ["EdDSA"],
			});
			return;
		}
		if (req.url === "/app") {
			res.end(JSON.stringify({ live: true }));
			return;
		}
		let body = "";
		req.on("data", (chunk) => {
			body += String(chunk);
		});
		req.on("end", () => {
			try {
				if (req.url === "/register") {
					send({
						registration_ref: "agent-one",
						granted_scopes: ["deploy:write"],
						private_key: pem(),
						issued_at: new Date().toISOString(),
						expires_at: future(),
						claim_endpoint: `${origin}/agent-claim`,
						rotation_endpoint: `${origin}/rotate`,
						revocation_endpoint: `${origin}/revoke`,
					});
					return;
				}
				if (req.url === "/token") {
					const form = new URLSearchParams(body);
					const assertion = form.get("client_assertion") ?? "";
					const [header, payload, signature] = assertion.split(".");
					const claims = JSON.parse(
						Buffer.from(payload ?? "", "base64url").toString(),
					);
					if (
						revoked ||
						!verify(
							null,
							Buffer.from(`${header}.${payload}`),
							keys.publicKey,
							Buffer.from(signature ?? "", "base64url"),
						)
					) {
						res.statusCode = 401;
						send({ error: "invalid_client" });
						return;
					}
					expect(form.get("grant_type")).toBe("client_credentials");
					expect(form.get("scope")).toBe("deploy:write");
					expect(claims).toMatchObject({
						iss: "agent-one",
						sub: "agent-one",
						aud: `${origin}/token`,
						tenant_id: "tenant-a",
						project_id: "auth-app",
						session_id: "session-a",
						audience: "broker-api",
						service: `${origin}/`,
						resource: `${origin}/`,
					});
					expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
					expect(claims.exp - claims.iat).toBeLessThanOrEqual(60);
					expect(assertions.has(claims.jti)).toBe(false);
					assertions.add(claims.jti);
					expect(body).not.toContain("PRIVATE KEY");
					const token = `issued-access-${++tokenCount}`;
					tokens.add(token);
					send({
						access_token: token,
						token_type: "Bearer",
						expires_in: 120,
						scope: widened ? "admin" : "deploy:write",
						audience: "broker-api",
						resource: `${origin}/`,
					});
					return;
				}
				const parsed = JSON.parse(body || "{}");
				if (req.url === "/anonymous") {
					send({
						ephemeralPrincipal: {
							kind: "service",
							id: "temporary-infrastructure",
						},
						accessToken: "ephemeral-infra-token",
						claimToken: "infrastructure-claim-secret",
						claimUrl: `${origin}/human-infra`,
						primaryUrl: `${origin}/app`,
						expiresAt: future(),
						ttlSeconds: 3600,
						deploymentId: "deployment-one",
						restrictions: [],
					});
					return;
				}
				if (req.url === "/place") {
					if (
						!tokens.has(
							(req.headers.authorization ?? "").replace(/^Bearer /u, ""),
						)
					) {
						res.statusCode = 401;
						send({ error: "invalid_token" });
						return;
					}
					expect(parsed.anonymous).toBe(true);
					expect(parsed.claimToken).toBe("infrastructure-claim-secret");
					placements++;
					send({
						deploymentId: "deployment-one",
						primaryUrl: `${origin}/app`,
						brokerId: "self-hosted",
						resources: { service: "live-self-hosted-resource" },
					});
					return;
				}
				if (req.url === "/infra-claim") {
					expect(parsed.claimToken).toBe("infrastructure-claim-secret");
					infraClaims++;
					send({
						deploymentId: "deployment-one",
						owner: { kind: "user", id: "human-owner" },
						previousOwner: { kind: "service", id: "temporary-infrastructure" },
						primaryUrl: `${origin}/app`,
						resources: { service: "live-self-hosted-resource" },
					});
					return;
				}
				if (req.url === "/agent-claim") {
					expect(parsed.requested_scopes).toEqual(["deploy:write"]);
					send({
						claim_url: `${origin}/human-agent`,
						poll_token: "private-poll-secret",
						poll_endpoint: `${origin}/agent-poll`,
						expires_at: future(),
						interval_seconds: 1,
					});
					return;
				}
				if (req.url === "/agent-poll") {
					expect(parsed.poll_token).toBe("private-poll-secret");
					send({
						status: "claimed",
						human_subject: "human-owner",
						granted_scopes: widened ? ["admin"] : ["deploy:write"],
						rotate_after_infrastructure_claim: true,
					});
					return;
				}
				if (req.url === "/rotate" || req.url === "/revoke") {
					expect(
						tokens.has(
							(req.headers.authorization ?? "").replace(/^Bearer /u, ""),
						),
					).toBe(true);
					expect(parsed.registration_ref).toBe("agent-one");
					if (req.url === "/revoke") {
						revoked = true;
						tokens.clear();
						send({ revoked: true });
						return;
					}
					rotations++;
					keys = generateKeyPairSync("ed25519");
					tokens.clear();
					send({ private_key: pem() });
					return;
				}
				res.statusCode = 404;
				send({ error: "missing" });
			} catch (error) {
				res.statusCode = 500;
				send({
					error: error instanceof Error ? error.message : "fixture failed",
				});
			}
		});
	});
	origin = fixture.origin;
	const priorHome = process.env.HOBO_HOME;
	const priorProject = process.env.HOBO_PROJECT;
	const priorTenant = process.env.HOBO_TENANT;
	process.env.HOBO_HOME = home;
	process.env.HOBO_PROJECT = "auth-app";
	process.env.HOBO_TENANT = "tenant-a";
	const runtime = createDefaultYardRuntime();
	const cli = createComposedHoboCli({
		yardRuntime: runtime,
		authMdFetch: fixture.fetchImpl,
	});
	const outputs: string[] = [];
	const run = async (args: string[], ok = true) => {
		const result = await cli.run([...args, "--json"], { cwd });
		outputs.push(result.stdout);
		const parsed = JSON.parse(result.stdout);
		expect(parsed.ok, result.stdout).toBe(ok);
		return parsed;
	};
	try {
		for (const args of [
			["identity", "--help"],
			["identity", "agent", "--help"],
		]) {
			const help = await cli.run(args, { cwd });
			expect(help.exitCode).toBe(0);
			expect(help.stdout).toContain("agent register <agent.json>");
			expect(help.stdout).toContain("private_key_jwt");
		}
		await writeFile(
			join(cwd, "agent.json"),
			JSON.stringify({
				resource: `${origin}/`,
				binding: {
					sessionId: "session-a",
					tenantId: "tenant-a",
					projectId: "auth-app",
					audience: "broker-api",
					service: origin,
				},
				requestedScopes: ["deploy:write"],
			}),
		);
		const beforeAdvertisements = advertisements;
		metadataMode = "invalid-standard";
		await run(["identity", "agent", "discover", origin], false);
		expect(advertisements).toBe(beforeAdvertisements);
		metadataMode = "denied-standard";
		await run(["identity", "agent", "discover", origin], false);
		expect(advertisements).toBe(beforeAdvertisements);
		for (const mode of ["cross-origin", "http"]) {
			metadataMode = mode;
			await run(["identity", "agent", "discover", origin], false);
		}
		metadataMode = "custom-only";
		const discovered = await run(["identity", "agent", "discover", origin]);
		expect(discovered.data.metadata.scopesSupported).toEqual(["deploy:write"]);
		const registered = await run([
			"identity",
			"agent",
			"register",
			"agent.json",
		]);
		expect(registered.data.phase).toBe("pre-claim");
		const command = (verb: string) => [
			"identity",
			"agent",
			verb,
			`${origin}/`,
			"agent-one",
		];
		await run(command("token"));
		metadataMode = "changed-resource";
		await run(command("token"), false);
		metadataMode = "custom-only";
		const child = await promisify(execFile)(
			process.execPath,
			[
				fileURLToPath(new URL("../dist/bin/hobo.js", import.meta.url)),
				...command("token"),
				"--json",
			],
			{
				cwd,
				env: { ...process.env, NODE_EXTRA_CA_CERTS: fixture.certificatePath },
				timeout: 120_000,
			},
		);
		expect(JSON.parse(child.stdout)).toMatchObject({
			ok: true,
			status: "token_exchanged",
			data: { registrationRef: "agent-one" },
		});
		outputs.push(child.stdout);
		widened = true;
		await run(command("token"), false);
		widened = false;
		const placed = await run(["up", "--broker", origin, "--anonymous"]);
		expect(placed.data.principal).toEqual({ kind: "agent", id: "agent-one" });
		expect(placements).toBe(1);
		expect(await (await fixture.fetchImpl(`${origin}/app`)).json()).toEqual({
			live: true,
		});
		const agentClaim = await run(command("claim"));
		expect(agentClaim.data.claimUrl).toBe(`${origin}/human-agent`);
		expect(infraClaims).toBe(0);
		widened = true;
		await run(command("poll"), false);
		widened = false;
		const polled = await run(command("poll"));
		expect(polled.data.postClaimScopes).toEqual(["deploy:write"]);
		expect(polled.data.infrastructureOwnership).toBe("independent");
		await run([
			"claim",
			"human-owner",
			"--broker",
			origin,
			"--token",
			"infrastructure-claim-secret",
		]);
		expect(infraClaims).toBe(1);
		const blocked = await run(["up", "--broker", origin, "--anonymous"], false);
		expect(blocked.message).toContain("rotate");
		expect(placements).toBe(1);
		const rotated = await run(command("rotate"));
		expect(rotated.data.rotationSatisfied).toBe(true);
		expect(rotations).toBe(1);
		const concurrentRotations = await Promise.all([
			run(command("rotate")),
			run(command("rotate")),
		]);
		expect(concurrentRotations.map((value) => value.status)).toEqual([
			"rotated",
			"rotated",
		]);
		expect(rotations).toBe(3);
		await run(command("token"));
		await run(["up", "--broker", origin, "--temporary"]);
		expect(placements).toBe(2);
		await run(command("revoke"));
		expect(revoked).toBe(true);
		const before = tokenCount;
		await run(command("token"), false);
		await run(command("claim"), false);
		await run(command("poll"), false);
		expect(tokenCount).toBe(before);
		await run(["up", "--broker", origin, "--anonymous"], false);
		expect(placements).toBe(2);
		const files = await readdir(join(home, "auth-md", "registrations"));
		expect(files).toHaveLength(1);
		const privatePath = join(home, "auth-md", "registrations", files[0] ?? "");
		expect((await stat(privatePath)).mode & 0o077).toBe(0);
		const privateRecord = JSON.parse(await readFile(privatePath, "utf8"));
		expect(privateRecord.privateKey).toBe("");
		expect(standardAttempts).toBeGreaterThan(5);
		expect(advertisements).toBeGreaterThan(5);
		expect(customReads).toBeGreaterThan(5);
		execFileSync(
			cueBinaryForRepo(),
			[
				"vet",
				"-c",
				"-d",
				"#StoredCliAuthMdStateRecord",
				fileURLToPath(
					new URL(
						"../../auth-md/data-models/cli-state/schema.cue",
						import.meta.url,
					),
				),
				privatePath,
			],
			{ stdio: "pipe" },
		);
		const publicOutput = outputs.join("\n");
		expect(publicOutput).not.toContain("issued-access-");
		const facts = [];
		for await (const event of runtime.store.read(
			`authmd:${JSON.stringify(["tenant-a", "auth-app", `${origin}/`, "agent-one"])}`,
		))
			facts.push(event);
		expect(facts.map((event) => event.type)).toEqual([
			"authmd.AgentRegistered",
			"authmd.ClaimInitiated",
			"authmd.PrincipalClaimed",
			"authmd.CredentialsRotated",
			"authmd.CredentialsRotated",
			"authmd.CredentialsRotated",
			"authmd.PrincipalRevoked",
		]);
		expect(JSON.stringify(facts)).not.toContain("private-poll-secret");
		expect(JSON.stringify(facts)).not.toContain("PRIVATE KEY");
		for (const secret of [...privateKeys, "private-poll-secret", ...tokens])
			expect(publicOutput).not.toContain(secret);
		for (const output of outputs) {
			const value = JSON.parse(output);
			expect(isJsonObject(value)).toBe(true);
		}
	} finally {
		runtime.store.close();
		if (priorHome === undefined) delete process.env.HOBO_HOME;
		else process.env.HOBO_HOME = priorHome;
		if (priorProject === undefined) delete process.env.HOBO_PROJECT;
		else process.env.HOBO_PROJECT = priorProject;
		if (priorTenant === undefined) delete process.env.HOBO_TENANT;
		else process.env.HOBO_TENANT = priorTenant;
		await fixture.close();
		await rm(home, { recursive: true, force: true });
	}
}, 300_000);
