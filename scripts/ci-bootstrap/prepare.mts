import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { APP_ID, fingerprint, REPOSITORY_ID } from "./protocol.mts";

const SOURCE = /^[0-9a-f]{40}$/;
export type PrepareControllerConfig = {
	runnerTemp: string;
	workspace: string;
	localPublicKeyBase64: string;
	runId: number;
	runAttempt: number;
	sourceSha: string;
};
const readyMetadata = z
	.object({
		version: z.literal(1),
		kind: z.literal("hobo-controller-ready"),
		appId: z.literal(APP_ID),
		repositoryId: z.literal(REPOSITORY_ID),
		runId: z.number().int().positive(),
		runAttempt: z.number().int().positive(),
		sourceSha: z.string().regex(SOURCE),
		publicKey: z.string().min(1),
		localPublicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export type ControllerReadyMetadata = z.output<typeof readyMetadata>;
function identity({
	runId,
	runAttempt,
	sourceSha,
}: Pick<PrepareControllerConfig, "runId" | "runAttempt" | "sourceSha">): void {
	if (
		!Number.isSafeInteger(runId) ||
		runId <= 0 ||
		!Number.isSafeInteger(runAttempt) ||
		runAttempt <= 0 ||
		!SOURCE.test(sourceSha)
	)
		throw new Error("invalid workflow identity");
}
function safeDir(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const st = lstatSync(path);
	if (!st.isDirectory() || st.isSymbolicLink())
		throw new Error("invalid controller directory");
}
function decodePublicKey(encoded: string): string {
	z.string()
		.min(1)
		.max(12000)
		.regex(/^[A-Za-z0-9+/]+={0,2}$/)
		.parse(encoded);
	const pem = Buffer.from(encoded, "base64").toString("utf8"),
		key = createPublicKey(pem);
	if (
		key.asymmetricKeyType !== "rsa" ||
		(key.asymmetricKeyDetails?.modulusLength ?? 0) < 3072
	)
		throw new Error("invalid local key");
	return pem;
}
export function prepareController({
	runnerTemp,
	workspace,
	localPublicKeyBase64,
	runId,
	runAttempt,
	sourceSha,
}: PrepareControllerConfig): ControllerReadyMetadata {
	identity({ runId, runAttempt, sourceSha });
	if (!isAbsolute(runnerTemp) || !isAbsolute(workspace))
		throw new Error("invalid workspace");
	const localPublicKey = decodePublicKey(localPublicKeyBase64),
		root = join(runnerTemp, `hobo-controller-${runId}-${runAttempt}`),
		publicDir = join(workspace, ".hobo-bootstrap-public");
	safeDir(root);
	safeDir(publicDir);
	const { publicKey, privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 3072,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	writeFileSync(join(root, "controller-private.pem"), privateKey, {
		mode: 0o600,
		flag: "wx",
	});
	const metadata: ControllerReadyMetadata = {
		version: 1,
		kind: "hobo-controller-ready",
		appId: APP_ID,
		repositoryId: REPOSITORY_ID,
		runId,
		runAttempt,
		sourceSha,
		publicKey,
		localPublicKeyFingerprint: fingerprint(localPublicKey),
	};
	writeFileSync(join(publicDir, "controller.json"), JSON.stringify(metadata), {
		mode: 0o600,
		flag: "wx",
	});
	return metadata;
}
export function loadPreparedController({
	runnerTemp,
	workspace,
	localPublicKeyBase64,
	runId,
	runAttempt,
	sourceSha,
}: PrepareControllerConfig) {
	identity({ runId, runAttempt, sourceSha });
	if (!isAbsolute(runnerTemp) || !isAbsolute(workspace))
		throw new Error("invalid workspace");
	const localPublicKey = decodePublicKey(localPublicKeyBase64),
		root = join(runnerTemp, `hobo-controller-${runId}-${runAttempt}`);
	const stat = lstatSync(root);
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("invalid controller directory");
	const privateKeyPath = join(root, "controller-private.pem"),
		keyStat = lstatSync(privateKeyPath);
	if (
		!keyStat.isFile() ||
		keyStat.isSymbolicLink() ||
		(keyStat.mode & 0o077) !== 0
	)
		throw new Error("invalid controller key");
	const privateKey = readFileSync(privateKeyPath, "utf8"),
		metadata = readyMetadata.parse(
			JSON.parse(
				readFileSync(
					join(workspace, ".hobo-bootstrap-public", "controller.json"),
					"utf8",
				),
			),
		);
	if (
		metadata.runId !== runId ||
		metadata.runAttempt !== runAttempt ||
		metadata.sourceSha !== sourceSha ||
		metadata.localPublicKeyFingerprint !== fingerprint(localPublicKey) ||
		fingerprint(metadata.publicKey) !== fingerprint(privateKey)
	)
		throw new Error("controller metadata mismatch");
	return { root, localPublicKey, privateKey, publicKey: metadata.publicKey };
}
