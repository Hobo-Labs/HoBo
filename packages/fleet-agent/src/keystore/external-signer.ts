// The external-signer protocol of design §6.4: a configured command reads one
// JSON request line on standard input and writes one JSON answer line on
// standard output. It is started once per request with no shell; the payload
// travels on standard input, never in its arguments or environment.
//
//   {"op":"public"}                     -> {"jwk":{"kty":…,"crv":…,"x":…[,"y":…]}}
//   {"op":"sign","payloadB64":"<b64>"}  -> {"signatureB64":"<b64>"}  (ES256 as P1363 r‖s; EdDSA raw)
//   {"op":"destroy"}                    -> {"ok":true}
//   any failure                         -> {"error":"<reason>"}
//
// `destroy` is this repository's addition to the two operations the design
// names: KeyStore.destroy must remove the identity key, and only the helper
// holds it. Every signature is verified against the helper's public key
// before it is returned.
import { spawn } from "node:child_process";
import { verify } from "node:crypto";
import type { JsonObject, JsonValue } from "@hobo/core";
import { KeyAlgorithm, type PublicJwk } from "@hobo/fleet";
import { parsePublicJwk } from "@hobo/fleet/keys";
import { algorithmOf, type Identity, publicJwkJson } from "./device-keys.js";
import { isJsonObject, isJsonString, parseJsonText } from "./json.js";

const ANSWER_LIMIT_BYTES = 64 * 1024;
/** Long enough for a person to touch a hardware token. */
const REQUEST_TIMEOUT_MS = 120_000;

function failure(reason: string): Error {
	return new Error(`the external signer ${reason}`);
}

function ask(
	command: readonly string[],
	request: JsonObject,
): Promise<JsonObject> {
	const [program, ...args] = command;
	if (program === undefined) return Promise.reject(failure("has no command"));
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, {
			stdio: ["pipe", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const settle = (outcome: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			outcome();
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			settle(() => reject(failure("did not answer in time")));
		}, REQUEST_TIMEOUT_MS);
		child.on("error", (error) =>
			settle(() => reject(failure(`could not be started: ${error.message}`))),
		);
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > ANSWER_LIMIT_BYTES) {
				child.kill("SIGKILL");
				settle(() => reject(failure("answered too much")));
				return;
			}
			chunks.push(chunk);
		});
		child.on("close", (code) =>
			settle(() => {
				const line = Buffer.concat(chunks).toString("utf8").split("\n")[0];
				const answer = parseJsonText(line ?? "");
				if (!isJsonObject(answer)) {
					reject(
						failure(
							`answered something other than a JSON object (exit code ${String(code)})`,
						),
					);
					return;
				}
				if (answer.error !== undefined) {
					reject(
						failure(
							`refused: ${isJsonString(answer.error) ? answer.error : "no reason given"}`,
						),
					);
					return;
				}
				if (code !== 0) {
					reject(failure(`exited with code ${String(code)}`));
					return;
				}
				resolve(answer);
			}),
		);
		child.stdin.on("error", () => {
			// The close handler reports a command that exits before reading.
		});
		child.stdin.end(`${JSON.stringify(request)}\n`);
	});
}

/** Only the public members of RFC 7517; a key carrying anything else (a private `d`) is refused. */
function publicKeyOf(value: JsonValue | undefined): PublicJwk {
	if (!isJsonObject(value)) throw failure("answered no public key");
	const extra = Object.keys(value).filter(
		(member) => !["kty", "crv", "x", "y"].includes(member),
	);
	if (extra.length > 0)
		throw failure(`answered a public key carrying ${extra.join(", ")}`);
	const parsed = parsePublicJwk(JSON.stringify(value));
	if (!parsed.ok)
		throw failure(
			`answered a public key that is not valid: ${parsed.error.message}`,
		);
	return parsed.value;
}

function verifies(
	jwk: PublicJwk,
	bytes: Uint8Array,
	signature: Uint8Array,
): boolean {
	const key = { key: publicJwkJson(jwk), format: "jwk" } as const;
	try {
		return algorithmOf(jwk) === KeyAlgorithm.ES256
			? verify(
					"sha256",
					bytes,
					{ ...key, dsaEncoding: "ieee-p1363" },
					signature,
				)
			: verify(null, bytes, key, signature);
	} catch {
		return false;
	}
}

/** The identity key behind `command`. */
export async function externalIdentity(
	command: readonly string[],
): Promise<Identity> {
	const jwk = publicKeyOf((await ask(command, { op: "public" })).jwk);
	return Object.freeze({
		jwk,
		async sign(bytes: Uint8Array): Promise<Uint8Array> {
			const answer = await ask(command, {
				op: "sign",
				payloadB64: Buffer.from(bytes).toString("base64"),
			});
			if (!isJsonString(answer.signatureB64))
				throw failure("answered no signature");
			const signature = new Uint8Array(
				Buffer.from(answer.signatureB64, "base64"),
			);
			if (!verifies(jwk, bytes, signature))
				throw failure(
					"answered a signature that does not verify against its public key",
				);
			return signature;
		},
	});
}

export async function destroyExternalIdentity(
	command: readonly string[],
): Promise<void> {
	await ask(command, { op: "destroy" });
}
