/**
 * Infisical's answers cross this parser once: JSON is read into the generated
 * protobuf records (`fromJson`, Infisical's camelCase names are the protobuf
 * JSON names) and then narrowed to the derived types the client hands out,
 * applying the constraints of `data-models/adapter_infisical.cue`.
 */

import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
	InfisicalLoginResponseSchema,
	type InfisicalSecret,
	type InfisicalSecretEnvelope,
	InfisicalSecretEnvelopeSchema,
	InfisicalSecretListSchema,
} from "./_generated/adapter_infisical_pb.js";
import { InfisicalError } from "./errors.js";

const ACCESS_TOKEN = /^[!-~]{1,16384}$/u;
const SECRET_KEY = /^[A-Za-z0-9_.-]{1,256}$/u;
const ONE_YEAR_SECONDS = 31_536_000;

/** A login, held in memory only. */
export type ParsedLogin = Readonly<{ accessToken: string; expiresIn: number }>;

/** A secret as read: its key, value and version. Never log `value`. */
export type ParsedSecret = Readonly<
	Pick<InfisicalSecret, "secretKey" | "version"> & { value: string }
>;

/** A secret listed without its value (`viewSecretValue=false`). */
export type ParsedSecretName = Readonly<
	Pick<InfisicalSecret, "secretKey" | "version">
>;

function malformed(operation: string): never {
	throw new InfisicalError(operation, "invalid-response");
}

function read<T>(operation: string, parse: () => T): T {
	try {
		return parse();
	} catch {
		return malformed(operation);
	}
}

export function parseLogin(json: JsonValue): ParsedLogin {
	const login = read("login", () =>
		fromJson(InfisicalLoginResponseSchema, json, {
			ignoreUnknownFields: true,
		}),
	);
	if (
		!ACCESS_TOKEN.test(login.accessToken) ||
		login.tokenType !== "Bearer" ||
		login.expiresIn <= 0 ||
		login.expiresIn > ONE_YEAR_SECONDS
	)
		malformed("login");
	return Object.freeze({
		accessToken: login.accessToken,
		expiresIn: login.expiresIn,
	});
}

function nameOf(
	operation: string,
	secret: InfisicalSecret | undefined,
): ParsedSecretName {
	if (!secret || !SECRET_KEY.test(secret.secretKey) || secret.version < 1)
		return malformed(operation);
	return Object.freeze({
		secretKey: secret.secretKey,
		version: secret.version,
	});
}

function secretOf(
	operation: string,
	secret: InfisicalSecret | undefined,
): ParsedSecret {
	const name = nameOf(operation, secret);
	if (!secret || secret.secretValueHidden)
		throw new InfisicalError(operation, "value-hidden");
	return Object.freeze({ ...name, value: secret.secretValue });
}

/** The envelope, refused when a secret-protection policy held the write. */
function envelopeOf(
	operation: string,
	json: JsonValue,
): InfisicalSecretEnvelope {
	const envelope = read(operation, () =>
		fromJson(InfisicalSecretEnvelopeSchema, json, {
			ignoreUnknownFields: true,
		}),
	);
	if (envelope.approval !== undefined)
		throw new InfisicalError(operation, "approval-required");
	return envelope;
}

export function parseSecretEnvelope(
	operation: string,
	json: JsonValue,
): ParsedSecret {
	return secretOf(operation, envelopeOf(operation, json).secret);
}

export function parseSecretList(
	operation: string,
	json: JsonValue,
): readonly ParsedSecret[] {
	const list = read(operation, () =>
		fromJson(InfisicalSecretListSchema, json, {
			ignoreUnknownFields: true,
		}),
	);
	const secrets = list.secrets.map((secret) => secretOf(operation, secret));
	if (
		new Set(secrets.map((secret) => secret.secretKey)).size !== secrets.length
	)
		malformed(operation);
	return Object.freeze(secrets);
}

export function parseSecretNames(
	operation: string,
	json: JsonValue,
): readonly ParsedSecretName[] {
	const list = read(operation, () =>
		fromJson(InfisicalSecretListSchema, json, {
			ignoreUnknownFields: true,
		}),
	);
	return Object.freeze(list.secrets.map((secret) => nameOf(operation, secret)));
}

/** The version a write produced; the echoed value is not read. */
export function parseWrittenVersion(
	operation: string,
	json: JsonValue,
): number {
	return nameOf(operation, envelopeOf(operation, json).secret).version;
}
