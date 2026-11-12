/**
 * The committed binding: where the relay and the deploy workflow find the
 * store once it exists (`packages/ci-vercel/deploy/secret-store.binding.json`).
 * Coordinates only, constrained by `#SecretStoreBinding` in
 * `data-models/secret_store_claim.cue`; a value shaped like a credential
 * cannot be represented.
 */
import {
	create,
	fromJsonString,
	type JsonValue,
	toJsonString,
} from "@bufbuild/protobuf";
import {
	type SecretStoreBinding,
	SecretStoreBindingSchema,
} from "./_generated/secret_store_claim_pb.js";
import { secretStoreError } from "./errors.js";
import { parseSecretStoreKind, type SecretStoreKind } from "./offers.js";

// public-contract: where `hobo ci secret-store provision` writes the binding, relative to the relay project.
export const SECRET_STORE_BINDING_FILE = "deploy/secret-store.binding.json";

export type ParsedSecretStoreBinding = Readonly<
	Omit<SecretStoreBinding, "kind" | "claimState" | "$typeName" | "$unknown"> & {
		kind: SecretStoreKind;
		claimState: "pending" | "claimed";
	}
>;

const ENDPOINT = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/u;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/u;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;

export function parseSecretStoreBinding(
	record: SecretStoreBinding,
	options: { readonly allowLoopback?: boolean } = {},
): ParsedSecretStoreBinding {
	const kind = parseSecretStoreKind(record.kind);
	const claimState =
		record.claimState === "pending" || record.claimState === "claimed"
			? record.claimState
			: undefined;
	const ok =
		claimState !== undefined &&
		(ENDPOINT.test(record.endpoint) ||
			(options.allowLoopback === true && LOOPBACK.test(record.endpoint))) &&
		ID.test(record.projectId) &&
		(record.deployProjectId === "" ||
			(ID.test(record.deployProjectId) &&
				record.deployProjectId !== record.projectId)) &&
		/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(record.environment) &&
		/^\/([A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*)?$/u.test(record.secretPath) &&
		ID.test(record.relayIdentityId) &&
		ID.test(record.deployIdentityId) &&
		record.relayIdentityId !== record.deployIdentityId &&
		(record.vercelTeamId === "" ||
			/^team_[A-Za-z0-9]{1,64}$/u.test(record.vercelTeamId)) &&
		/^[a-z0-9][a-z0-9:._-]{0,127}$/u.test(record.claimBundleId);
	if (!ok || claimState === undefined)
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"the secret store binding does not meet its constraints (coordinates only, two distinct identities in two distinct projects, an HTTPS endpoint without userinfo)",
		);
	return Object.freeze({
		kind,
		endpoint: record.endpoint,
		projectId: record.projectId,
		deployProjectId: record.deployProjectId,
		environment: record.environment,
		secretPath: record.secretPath,
		relayIdentityId: record.relayIdentityId,
		deployIdentityId: record.deployIdentityId,
		vercelTeamId: record.vercelTeamId,
		claimBundleId: record.claimBundleId,
		claimState,
	});
}

/** Read the committed file's text. The error never quotes it. */
export function readSecretStoreBinding(
	text: string,
	options: { readonly allowLoopback?: boolean } = {},
): ParsedSecretStoreBinding {
	let record: SecretStoreBinding;
	try {
		record = fromJsonString(SecretStoreBindingSchema, text);
	} catch {
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"the secret store binding is not a SecretStoreBinding record",
		);
	}
	return parseSecretStoreBinding(record, options);
}

/** The file's text: stable field order, a trailing newline. */
export function formatSecretStoreBinding(
	binding: ParsedSecretStoreBinding,
): string {
	const record = create(SecretStoreBindingSchema, binding);
	const json: JsonValue = JSON.parse(
		toJsonString(SecretStoreBindingSchema, record),
	);
	return `${JSON.stringify(json, null, "\t")}\n`;
}
