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
// public-contract: the relay's folder path in its project (the layout `provision` creates).
export const RELAY_SECRET_PATH = "/hobo-ci-relay";

export type ParsedSecretStoreBinding = Readonly<
	Omit<SecretStoreBinding, "kind" | "claimState" | "$typeName" | "$unknown"> & {
		kind: SecretStoreKind;
		claimState: "pending" | "claimed";
		readonly strictParse: true;
	}
>;

export type RepairSecretStoreBinding = Readonly<
	Omit<ParsedSecretStoreBinding, "strictParse">
>;

const ENDPOINT = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/u;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/u;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
// GitHub's legacy or immutable prefix, then the branch; never a glob.
const DEPLOY_SUBJECT =
	/^repo:[A-Za-z0-9-]{1,39}(@\d{1,20})?\/[A-Za-z0-9._-]{1,100}(@\d{1,20})?:ref:refs\/heads\/[A-Za-z0-9._/-]{1,200}$/u;

function claimStateOf(
	record: SecretStoreBinding,
): "pending" | "claimed" | undefined {
	return record.claimState === "pending" || record.claimState === "claimed"
		? record.claimState
		: undefined;
}

function bindingMeetsConstraints(
	record: SecretStoreBinding,
	claimState: "pending" | "claimed",
	options: { readonly allowLoopback?: boolean },
	legacy: boolean,
): boolean {
	const deployCredentialIdentityId = record.deployCredentialIdentityId ?? "";
	const preCutover =
		record.deployProjectId === "" &&
		deployCredentialIdentityId === "" &&
		record.deployOidcSubject === "";
	return (
		(legacy ? preCutover : !preCutover) &&
		(ENDPOINT.test(record.endpoint) ||
			(options.allowLoopback === true && LOOPBACK.test(record.endpoint))) &&
		ID.test(record.projectId) &&
		((legacy && record.deployProjectId === "") ||
			(ID.test(record.deployProjectId) &&
				record.deployProjectId !== record.projectId)) &&
		/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(record.environment) &&
		/^\/([A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*)?$/u.test(record.secretPath) &&
		ID.test(record.relayIdentityId) &&
		ID.test(record.deployIdentityId) &&
		record.relayIdentityId !== record.deployIdentityId &&
		((ID.test(deployCredentialIdentityId) &&
			deployCredentialIdentityId !== record.relayIdentityId &&
			deployCredentialIdentityId !== record.deployIdentityId) ||
			(legacy && deployCredentialIdentityId === "")) &&
		(record.vercelTeamId === "" ||
			/^team_[A-Za-z0-9]{1,64}$/u.test(record.vercelTeamId)) &&
		/^[a-z0-9][a-z0-9:._-]{0,127}$/u.test(record.claimBundleId) &&
		(record.deployOidcSubject === "" ||
			DEPLOY_SUBJECT.test(record.deployOidcSubject)) &&
		(claimState !== "claimed" || record.deployOidcSubject !== "" || legacy)
	);
}

function bindingFields(
	record: SecretStoreBinding,
	kind: SecretStoreKind,
	claimState: "pending" | "claimed",
): RepairSecretStoreBinding {
	return Object.freeze({
		kind,
		endpoint: record.endpoint,
		projectId: record.projectId,
		deployProjectId: record.deployProjectId,
		environment: record.environment,
		secretPath: record.secretPath,
		relayIdentityId: record.relayIdentityId,
		deployIdentityId: record.deployIdentityId,
		deployCredentialIdentityId: record.deployCredentialIdentityId ?? "",
		vercelTeamId: record.vercelTeamId,
		claimBundleId: record.claimBundleId,
		claimState,
		deployOidcSubject: record.deployOidcSubject,
	});
}

export function parseSecretStoreBinding(
	record: SecretStoreBinding,
	options: { readonly allowLoopback?: boolean } = {},
): ParsedSecretStoreBinding {
	const kind = parseSecretStoreKind(record.kind);
	const claimState = claimStateOf(record);
	if (
		claimState === undefined ||
		!bindingMeetsConstraints(record, claimState, options, false)
	)
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"the secret store binding does not meet its constraints (coordinates only, a deploy project of its own other than the relay's, a deploy credential identity distinct from the relay and writer identities, a recorded deploy subject when claimed, and an HTTPS endpoint without userinfo)",
		);
	const parsed: ParsedSecretStoreBinding = {
		...bindingFields(record, kind, claimState),
		strictParse: true,
	};
	return Object.freeze(parsed);
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

export function readSecretStoreBindingForRepair(
	text: string,
	options: { readonly allowLoopback?: boolean } = {},
): RepairSecretStoreBinding {
	let record: SecretStoreBinding;
	try {
		record = fromJsonString(SecretStoreBindingSchema, text);
	} catch {
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"the secret store binding is not a SecretStoreBinding record",
		);
	}
	const kind = parseSecretStoreKind(record.kind);
	const claimState = claimStateOf(record);
	if (
		claimState === undefined ||
		!bindingMeetsConstraints(record, claimState, options, true)
	)
		return secretStoreError(
			"SECRET_STORE_INVALID",
			"the secret store binding does not meet its constraints (coordinates only, a deploy project of its own other than the relay's, a deploy credential identity distinct from the relay and writer identities, a recorded deploy subject when claimed, and an HTTPS endpoint without userinfo)",
		);
	return bindingFields(record, kind, claimState);
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
