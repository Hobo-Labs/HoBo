// A stand-in hardware signer for the external-signer key store tests. It
// speaks the line-delimited JSON protocol of design §6.4 on stdin and stdout:
//   {"op":"public"}                 -> {"jwk":{...}}
//   {"op":"sign","payloadB64":"…"}  -> {"signatureB64":"…"}
//   {"op":"destroy"}                -> {"ok":true}
// The key lives in the directory named by its first argument and is created on
// first use. The second argument picks a misbehaviour for the refusal tests.
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [keyDir, mode = "honest"] = process.argv.slice(2);
const keyFile = join(keyDir, "identity.pem");

function key() {
	if (!existsSync(keyFile)) {
		mkdirSync(keyDir, { recursive: true });
		const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
		writeFileSync(
			keyFile,
			pair.privateKey.export({ type: "pkcs8", format: "pem" }),
			{ mode: 0o600 },
		);
	}
	return createPrivateKey(readFileSync(keyFile, "utf8"));
}

function answer(request) {
	if (mode === "fail") return { error: "the token is not present" };
	if (request.op === "public") {
		const jwk = key().export({ format: "jwk" });
		if (mode === "private-jwk") return { jwk };
		return { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } };
	}
	if (request.op === "sign") {
		const payload = Buffer.from(request.payloadB64, "base64");
		const signed =
			mode === "wrong-signature" ? Buffer.from("other bytes") : payload;
		const signature = sign("sha256", signed, {
			key: key(),
			dsaEncoding: "ieee-p1363",
		});
		return { signatureB64: signature.toString("base64") };
	}
	if (request.op === "destroy") {
		rmSync(keyFile, { force: true });
		return { ok: true };
	}
	return { error: `unknown op ${request.op}` };
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	const reply =
		mode === "garbage" ? "not json" : JSON.stringify(answer(JSON.parse(line)));
	if (mode === "argv-log")
		writeFileSync(join(keyDir, "argv.json"), JSON.stringify(process.argv));
	process.stdout.write(`${reply}\n`);
	if (mode === "fail") process.exitCode = 3;
});
