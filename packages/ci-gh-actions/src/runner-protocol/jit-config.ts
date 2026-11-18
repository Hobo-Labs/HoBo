/**
 * `parseJitConfig`: decode and check the one-job runner configuration GitHub
 * returns from `generate-jitconfig` (`encoded_jit_config`), before anything
 * signs in with it or hands it to a runner program (ADR-0183).
 *
 * The format is the one the runner itself decodes in
 * `Runner.Listener/Runner.cs` (`--jitconfig`): base64 of a JSON object whose
 * keys are file names (`.runner`, `.credentials`, `.credentials_rsaparams`) and
 * whose values are each file's bytes in base64.
 *
 * - `.runner` is `RunnerSettings` (`Runner.Common/ConfigurationStore.cs`).
 * - `.credentials` is `CredentialData` (`Runner.Common/CredentialData.cs`);
 *   the OAuth fields it holds are written in
 *   `Runner.Listener/Configuration/ConfigurationManager.cs` and read in
 *   `Runner.Listener/Configuration/OAuthCredential.cs`.
 * - `.credentials_rsaparams` is `RSAParametersSerializable`
 *   (`Runner.Listener/Configuration/IRSAKeyManager.cs`): the private key as
 *   base64 byte arrays.
 *
 * A configuration is refused unless every URL in it is https on a GitHub host,
 * no two keys in it differ only by case, and the runner is the one expected.
 */
import { Buffer } from "node:buffer";
import {
	createPrivateKey,
	createPublicKey,
	type KeyObject,
	sign,
	verify,
} from "node:crypto";
import { z } from "zod";
import { ProtocolJsonRejection, readProtocolJson } from "./json.js";
import type { ParsedJitConfig } from "./port.js";

/** A one-job runner configuration was refused. The message says why and holds no secret. */
export class JitConfigRejection extends Error {
	override readonly name = "JitConfigRejection";
}

/**
 * GitHub's own hosts: `github.com` and its subdomains, the Actions service
 * hosts under `actions.githubusercontent.com`, and the broker and data
 * residency hosts the runner itself recognises as GitHub's
 * (`RunnerSettings.IsHostedServer` in `Runner.Common/ConfigurationStore.cs`:
 * `.actions.githubusercontent.com`, `.githubapp.com`, `.ghe.com`).
 */
const GITHUB_HOST_SUFFIXES = [
	".github.com",
	".actions.githubusercontent.com",
	".githubapp.com",
	".ghe.com",
] as const;

/** Whether `text` is an https URL on a GitHub host, with no credentials or port in it. */
export function isGithubServiceUrl(text: string): boolean {
	if (!URL.canParse(text)) return false;
	const url = new URL(text);
	if (url.protocol !== "https:") return false;
	if (url.username !== "" || url.password !== "" || url.port !== "")
		return false;
	const host = url.hostname.toLowerCase();
	return (
		host === "github.com" ||
		GITHUB_HOST_SUFFIXES.some(
			(suffix) => host.endsWith(suffix) && host.length > suffix.length,
		)
	);
}

const FILES = z.record(z.string(), z.string());

const ID = z.union([
	z.number().int().positive(),
	z
		.string()
		.regex(/^[1-9][0-9]{0,18}$/u)
		.transform(Number)
		.pipe(z.number().int().positive()),
]);

/** `.runner`, keys lower-cased. JIT runners may leave `GitHubUrl` empty (`IsHostedServer`). */
const RUNNER_FILE = z.object({
	agentid: ID,
	agentname: z.string().min(1),
	poolid: ID,
	serverurl: z.string().default(""),
	githuburl: z.string().default(""),
	workfolder: z.string().default("_work"),
	usev2flow: z.boolean().default(false),
	serverurlv2: z.string().default(""),
});

/** `.credentials`, keys lower-cased; `data` holds `clientId` and `authorizationUrl`. */
const CREDENTIALS_FILE = z.object({
	scheme: z.literal("OAuth"),
	data: z.object({
		clientid: z.string().min(1),
		authorizationurl: z.string().min(1),
	}),
});

const BASE64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/u);

/** `.credentials_rsaparams`, keys lower-cased: `RSAParametersSerializable.GetObjectData`. */
const RSA_FILE = z.object({
	d: BASE64,
	dp: BASE64,
	dq: BASE64,
	exponent: BASE64,
	inverseq: BASE64,
	modulus: BASE64,
	p: BASE64,
	q: BASE64,
});

function base64url(base64: string): string {
	return Buffer.from(base64, "base64").toString("base64url");
}

/**
 * The private key in a `.credentials_rsaparams` text. Throws a
 * `JitConfigRejection` when the text is not a usable RSA private key.
 */
export function jitSigningKey(rsaParameters: string): KeyObject {
	const rsa = readFile(rsaParameters, RSA_FILE, ".credentials_rsaparams");
	const unusable = new JitConfigRejection(
		".credentials_rsaparams is not a usable RSA private key",
	);
	const n = base64url(rsa.modulus);
	const e = base64url(rsa.exponent);
	let key: KeyObject;
	try {
		key = createPrivateKey({
			format: "jwk",
			key: {
				kty: "RSA",
				n,
				e,
				d: base64url(rsa.d),
				p: base64url(rsa.p),
				q: base64url(rsa.q),
				dp: base64url(rsa.dp),
				dq: base64url(rsa.dq),
				qi: base64url(rsa.inverseq),
			},
		});
	} catch {
		throw unusable;
	}
	// A key whose parts do not belong together still imports; a signature its
	// own public half cannot verify shows it.
	const probe = Buffer.from("hobo-relay key check");
	let verified = false;
	try {
		verified = verify(
			"sha256",
			probe,
			createPublicKey({ format: "jwk", key: { kty: "RSA", n, e } }),
			sign("sha256", probe, key),
		);
	} catch {
		throw unusable;
	}
	if (!verified) throw unusable;
	return key;
}

function readFile<T>(text: string, schema: z.ZodType<T>, what: string): T {
	try {
		return readProtocolJson(text, schema, what, "refuse");
	} catch (error) {
		if (error instanceof ProtocolJsonRejection)
			throw new JitConfigRejection(error.message);
		throw error;
	}
}

function decodeBase64(text: string, what: string): string {
	const trimmed = text.trim();
	if (!BASE64.safeParse(trimmed).success)
		throw new JitConfigRejection(`${what} is not base64`);
	return Buffer.from(trimmed, "base64").toString("utf8");
}

function fileText(files: ReadonlyMap<string, string>, name: string): string {
	const encoded = files.get(name);
	if (encoded === undefined)
		throw new JitConfigRejection(`the configuration has no ${name} file`);
	return decodeBase64(encoded, name);
}

function needGithubUrl(text: string, field: string): void {
	if (!isGithubServiceUrl(text))
		throw new JitConfigRejection(
			`${field} is not an https URL on a GitHub host`,
		);
}

/** What a configuration must be: the runner it was created for. */
export type JitConfigExpectation = Readonly<{
	/** The runner name the caller asked GitHub to create. */
	runnerName: string;
}>;

/**
 * Decode an `encoded_jit_config` and check it. Throws a `JitConfigRejection`
 * naming the first rule it breaks; the message never holds a key or token.
 */
export function parseJitConfig(
	encoded: string,
	expect: JitConfigExpectation,
): ParsedJitConfig {
	const outer = readFile(
		decodeBase64(encoded, "the configuration"),
		FILES,
		"the configuration",
	);
	const files = new Map(Object.entries(outer));
	const runner = readFile(fileText(files, ".runner"), RUNNER_FILE, ".runner");
	const credentials = readFile(
		fileText(files, ".credentials"),
		CREDENTIALS_FILE,
		".credentials",
	);
	const rsaParameters = fileText(files, ".credentials_rsaparams");
	jitSigningKey(rsaParameters);
	if (runner.agentname !== expect.runnerName)
		throw new JitConfigRejection(
			`the configuration is for runner "${runner.agentname}", not "${expect.runnerName}"`,
		);
	needGithubUrl(credentials.data.authorizationurl, "authorizationUrl");
	if (runner.serverurl !== "") needGithubUrl(runner.serverurl, "ServerUrl");
	if (runner.serverurlv2 !== "")
		needGithubUrl(runner.serverurlv2, "ServerUrlV2");
	if (runner.githuburl !== "") needGithubUrl(runner.githuburl, "GitHubUrl");
	if (runner.serverurl === "" && runner.serverurlv2 === "")
		throw new JitConfigRejection(
			"the configuration names no runner service URL",
		);
	const config = {
		runner: Object.freeze({
			agentId: runner.agentid,
			agentName: runner.agentname,
			poolId: runner.poolid,
			serverUrl: runner.serverurl,
			gitHubUrl: runner.githuburl,
			workFolder: runner.workfolder,
			useV2Flow: runner.usev2flow,
			serverUrlV2: runner.serverurlv2,
		}),
		credentials: Object.freeze({
			scheme: credentials.scheme,
			clientId: credentials.data.clientid,
			authorizationUrl: credentials.data.authorizationurl,
		}),
		rsaParameters,
	};
	// SAFETY: every rule above held; the brand only records that it did.
	return Object.freeze(config) as ParsedJitConfig;
}
