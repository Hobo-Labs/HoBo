import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { isJsonString } from "@hobo/cd-gitops";
import {
	type ArgocdControlRecord,
	ArgocdControlRecordSchema,
} from "./_generated/argocd_pb.js";
import { ArgocdError } from "./errors.js";

// public-contract: Argo CD control client configuration schema id.
export const ARGCD_CONTROL_SCHEMA = "hobo.cd-argocd.control/v1" as const;

export type ArgocdControlConfig = ArgocdControlRecord & {
	readonly __brand: "cd-argocd.ArgocdControlConfig";
};

const HTTPS_URL = /^https:\/\/[^/@?#\s]+(\/[^?#\s]*)?$/u;
const K8S_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/u;

export function isArgocdResourceName(value: string): boolean {
	return isJsonString(value) && K8S_NAME.test(value);
}

function invalid(detail: string): never {
	throw new ArgocdError("argocd-body-invalid", detail);
}

export function parseArgocdControlConfig(
	value: JsonValue,
): ArgocdControlConfig {
	const record = fromJson(ArgocdControlRecordSchema, value);
	const url = URL.canParse(record.apiBaseUrl)
		? new URL(record.apiBaseUrl)
		: undefined;
	if (
		!HTTPS_URL.test(record.apiBaseUrl) ||
		url === undefined ||
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== ""
	)
		invalid(
			"api_base_url must be an https URL without credentials, query, or fragment",
		);
	if (!isArgocdResourceName(record.application))
		invalid("application must be a DNS-1123 label");
	if (!isArgocdResourceName(record.appNamespace))
		invalid("app_namespace must be a DNS-1123 label");
	if (record.tokenRef === "") invalid("token_ref must not be empty");
	const branded = create(ArgocdControlRecordSchema, record);
	return Object.freeze(
		Object.assign(branded, {
			__brand: "cd-argocd.ArgocdControlConfig" as const,
		}),
	);
}
