// Parse, don't validate: a publisher configuration crosses one parser and
// comes out as `PublisherConfig`, a branded generated record whose defaults
// are filled and whose constraints (data-models/gitops.cue) hold.

import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
	type EngineEndpointRecord,
	GitHost,
	GitopsEngine,
	type GitopsPublisherRecord,
	GitopsPublisherRecordSchema,
	type GitRepositoryRecord,
} from "./_generated/gitops_pb.js";
import { GitopsError } from "./errors.js";

// public-contract: publisher configuration schema id.
export const PUBLISHER_SCHEMA = "hobo.cd-gitops.publisher/v1" as const;

/** A publisher configuration that passed every gitops.cue constraint. */
export type PublisherConfig = GitopsPublisherRecord & {
	readonly repository: GitRepositoryRecord;
	readonly endpoint: EngineEndpointRecord;
	readonly __brand: "cd-gitops.PublisherConfig";
};

const HTTPS_URL = /^https:\/\/[^/@?#\s]+(\/[^?#\s]*)?$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/u;
const BRANCH = /^[A-Za-z0-9._/-]+$/u;
const PATH_PREFIX = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/u;
const K8S_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/u;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const INTERVAL = /^[0-9]+(ms|s|m|h)$/u;

function invalid(detail: string): never {
	throw new GitopsError("gitops-config-invalid", detail);
}

function https(value: string, field: string): string {
	if (!HTTPS_URL.test(value))
		invalid(
			`${field} must be an https URL without credentials, query or fragment`,
		);
	return value.replace(/\/+$/u, "");
}

function k8sName(value: string, field: string, fallback: string): string {
	const name = value === "" ? fallback : value;
	if (!K8S_NAME.test(name)) invalid(`${field} must be a DNS-1123 label`);
	return name;
}

export function parsePublisherConfig(input: JsonValue): PublisherConfig {
	let record: GitopsPublisherRecord;
	try {
		record = fromJson(GitopsPublisherRecordSchema, input);
	} catch (error) {
		invalid(
			`not a GitopsPublisherRecord: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (record.schemaVersion !== PUBLISHER_SCHEMA)
		invalid(`schema_version must be ${PUBLISHER_SCHEMA}`);
	if (!NAME.test(record.name))
		invalid("name must be a lowercase identifier (e.g. argo-cd, flux)");
	if (record.engine === GitopsEngine.UNSPECIFIED)
		invalid("engine is required (ARGO_CD or FLUX)");
	const repo = record.repository;
	const endpoint = record.endpoint;
	if (repo === undefined || endpoint === undefined)
		invalid("repository and endpoint are required");
	if (repo.host === GitHost.UNSPECIFIED) invalid("repository.host is required");
	if (!REPOSITORY.test(repo.repository))
		invalid("repository.repository must be owner/name");
	if (
		!BRANCH.test(repo.branch) ||
		repo.branch.includes("..") ||
		repo.branch.startsWith("/") ||
		repo.branch.endsWith("/")
	) {
		invalid("repository.branch is not a valid branch name");
	}
	if (
		!PATH_PREFIX.test(repo.pathPrefix) ||
		/(^|\/)\.\.?(\/|$)/u.test(repo.pathPrefix)
	) {
		invalid(
			"repository.path_prefix must be a relative path without dot segments",
		);
	}
	if (repo.credentialRef === "" || endpoint.credentialRef === "")
		invalid("credential references are required");
	if (record.interval !== "" && !INTERVAL.test(record.interval))
		invalid("interval must look like 30s, 1m or 1h");
	const isArgo = record.engine === GitopsEngine.ARGO_CD;
	const parsed = create(GitopsPublisherRecordSchema, {
		schemaVersion: PUBLISHER_SCHEMA,
		name: record.name,
		engine: record.engine,
		autoSync: record.autoSync,
		prune: record.prune,
		interval: record.interval === "" ? "1m" : record.interval,
		repository: {
			host: repo.host,
			apiBaseUrl: https(repo.apiBaseUrl, "repository.api_base_url"),
			repository: repo.repository,
			branch: repo.branch,
			pathPrefix: repo.pathPrefix,
			cloneUrl: https(repo.cloneUrl, "repository.clone_url"),
			credentialRef: repo.credentialRef,
		},
		endpoint: {
			apiBaseUrl: https(endpoint.apiBaseUrl, "endpoint.api_base_url"),
			credentialRef: endpoint.credentialRef,
			namespace: k8sName(
				endpoint.namespace,
				"endpoint.namespace",
				isArgo ? "argocd" : "flux-system",
			),
			project: endpoint.project === "" ? "default" : endpoint.project,
			destinationServer:
				endpoint.destinationServer === ""
					? "https://kubernetes.default.svc"
					: https(endpoint.destinationServer, "endpoint.destination_server"),
			destinationNamespace: k8sName(
				endpoint.destinationNamespace,
				"endpoint.destination_namespace",
				"hobo-system",
			),
			sourceRef: k8sName(endpoint.sourceRef, "endpoint.source_ref", "hobo"),
		},
	});
	// SAFETY: every constraint of #GitopsPublisherRecord was checked above.
	return parsed as PublisherConfig;
}
