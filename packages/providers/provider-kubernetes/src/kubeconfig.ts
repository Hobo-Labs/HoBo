import { parse } from "yaml";

import { KubernetesProviderError } from "./errors.js";
import {
	cloneAsJson,
	isJsonArray,
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export type KubernetesTlsMaterial = Readonly<{
	ca?: string;
	cert?: string;
	key?: string;
}>;

export type KubernetesClusterAccess = Readonly<{
	apiServerUrl: string;
	bearerToken?: string;
	tls: KubernetesTlsMaterial;
	secrets: readonly string[];
}>;

const FILE_REFERENCES = [
	"certificate-authority",
	"client-certificate",
	"client-key",
	"tokenFile",
] as const;

const PLUGIN_AUTH = ["exec", "auth-provider", "username", "password"] as const;

function unsupported(problem: string): never {
	throw new KubernetesProviderError("KUBECONFIG_UNSUPPORTED", problem);
}

function documentOf(text: string): JsonObject {
	let decoded: JsonValue;
	try {
		decoded = cloneAsJson(parse(text));
	} catch {
		return unsupported("the kubeconfig is not YAML or JSON");
	}
	return isJsonObject(decoded)
		? decoded
		: unsupported("the kubeconfig is not a mapping");
}

function named(document: JsonObject, list: string, name: string): JsonObject {
	const entries = document[list];
	const entry = isJsonArray(entries)
		? entries.find(
				(candidate) => isJsonObject(candidate) && candidate.name === name,
			)
		: undefined;
	const body = isJsonObject(entry) ? entry[list.slice(0, -1)] : undefined;
	return isJsonObject(body)
		? body
		: unsupported(
				`the kubeconfig's current context names a missing ${list.slice(0, -1)}`,
			);
}

function text(body: JsonObject, field: string): string | undefined {
	const value = body[field];
	return isJsonString(value) && value !== "" ? value : undefined;
}

function decoded(body: JsonObject, field: string): string | undefined {
	const value = text(body, field);
	return value === undefined
		? undefined
		: Buffer.from(value, "base64").toString("utf8");
}

export function parseKubeconfig(kubeconfig: string): KubernetesClusterAccess {
	const document = documentOf(kubeconfig);
	const current = text(document, "current-context");
	if (current === undefined)
		return unsupported("the kubeconfig names no current-context");
	const context = named(document, "contexts", current);
	const clusterName = text(context, "cluster");
	const userName = text(context, "user");
	if (clusterName === undefined || userName === undefined)
		return unsupported(
			"the kubeconfig's current context names no cluster or user",
		);
	const cluster = named(document, "clusters", clusterName);
	const user = named(document, "users", userName);
	const server = text(cluster, "server");
	if (server === undefined)
		return unsupported("the kubeconfig's cluster names no server");
	const skipVerify = cluster["insecure-skip-tls-verify"];
	if (isJsonBoolean(skipVerify) && skipVerify)
		return unsupported(
			"the kubeconfig skips TLS verification; give the cluster's certificate-authority-data instead",
		);
	for (const field of FILE_REFERENCES)
		if (cluster[field] !== undefined || user[field] !== undefined)
			return unsupported(
				`the kubeconfig points at a file (${field}); inline it as ${field === "tokenFile" ? "token" : `${field}-data`}, since HoBo reads no files from it`,
			);
	for (const field of PLUGIN_AUTH)
		if (user[field] !== undefined)
			return unsupported(
				`the kubeconfig authenticates with ${field}; use a bearer token or inline client certificate data`,
			);
	const bearerToken = text(user, "token");
	const cert = decoded(user, "client-certificate-data");
	const key = decoded(user, "client-key-data");
	if ((cert === undefined) !== (key === undefined))
		return unsupported(
			"the kubeconfig carries only half of a client certificate pair",
		);
	if (bearerToken === undefined && cert === undefined)
		return unsupported(
			"the kubeconfig's user has neither a token nor client certificate data",
		);
	const ca = decoded(cluster, "certificate-authority-data");
	const tls: KubernetesTlsMaterial = {
		...(ca !== undefined ? { ca } : undefined),
		...(cert !== undefined ? { cert } : undefined),
		...(key !== undefined ? { key } : undefined),
	};
	return {
		apiServerUrl: server,
		...(bearerToken !== undefined ? { bearerToken } : undefined),
		tls,
		secrets: [bearerToken, key, text(user, "client-key-data")].filter(
			(secret): secret is string => secret !== undefined,
		),
	};
}
