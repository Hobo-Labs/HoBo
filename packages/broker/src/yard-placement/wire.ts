import { Buffer } from "node:buffer";
import { fromBinary, fromJsonString, toBinary } from "@bufbuild/protobuf";
import {
	BindleDeploymentRequestSchema,
	type CampPlacementLayout,
} from "../_generated/yard_placement_pb.js";
import { cloneAsJson } from "../json.js";
import { parseBindleDeploymentRequest } from "./deploy.js";
import {
	type BindleDeploymentRequest,
	contentHashOf,
	type YardSelectionMode,
} from "./types.js";

const WORK_BINDING_VERSION = 1;
const REQUEST_DIGEST = /^sha256:[0-9a-f]{64}$/;
// Keep the original protobuf JSON field name for compatibility.
const YARD_LAYOUT_FIELD = "requestedShape";

function selectionMode(value: string): value is YardSelectionMode {
	return (
		value === "exact" ||
		value === "compatible" ||
		value === "compatible-or-generate"
	);
}

function campLayout(layout: CampPlacementLayout) {
	return {
		...(layout.id !== undefined ? { id: layout.id } : undefined),
		...(layout.env !== undefined ? { env: layout.env } : undefined),
		...(layout.envType !== undefined ? { envType: layout.envType } : undefined),
		require: layout.require,
		prefer: layout.prefer,
		labels: layout.labels,
		runtimeRequirements: layout.runtimeRequirements,
	};
}

/**
 * Encode a canonical domain request as a complete versioned work snapshot.
 * The digest detects disagreement with the snapshot, but is not authentication.
 */
export function encodeBindleDeploymentRequest(
	request: BindleDeploymentRequest,
): Uint8Array {
	if (
		!Number.isFinite(request.spendEstimateUsd) ||
		request.spendEstimateUsd < 0
	)
		throw new TypeError("spendEstimateUsd must be finite and nonnegative");
	const normalized = parseBindleDeploymentRequest(cloneAsJson(request));
	if (contentHashOf(request) !== contentHashOf(normalized))
		throw new TypeError("deployment request must be canonical");
	if (
		!normalized.ownerTenantId ||
		!normalized.objective ||
		!normalized.yard.requestId
	)
		throw new TypeError(
			"tenant, objective, and Yard request identity are required",
		);
	const { yard, ...rest } = normalized;
	const { requestedLayout, ...yardFields } = yard;
	const message = fromJsonString(
		BindleDeploymentRequestSchema,
		JSON.stringify({
			...rest,
			yard: { ...yardFields, [YARD_LAYOUT_FIELD]: requestedLayout },
			workBindingVersion: WORK_BINDING_VERSION,
			requestDigest: contentHashOf(normalized),
		}),
	);
	const bytes = toBinary(BindleDeploymentRequestSchema, message);
	// Reject values that protobuf cannot represent without changing the digest
	// (for example, an unpaired UTF-16 surrogate in a JavaScript string).
	decodeBindleDeploymentRequest(bytes);
	return bytes;
}

/**
 * Decode only complete, internally consistent work snapshots. Callers must
 * compare the resulting request digest with separately authenticated authority.
 */
export function decodeBindleDeploymentRequest(
	bytes: Uint8Array,
): BindleDeploymentRequest {
	const message = fromBinary(BindleDeploymentRequestSchema, bytes);
	// Unknown fields in ordinary protobuf messages are retained recursively.
	// Refuse to discard fields introduced by a newer request schema.
	const withUnknown = toBinary(BindleDeploymentRequestSchema, message);
	const withoutUnknown = toBinary(BindleDeploymentRequestSchema, message, {
		writeUnknownFields: false,
	});
	if (!Buffer.from(withUnknown).equals(Buffer.from(withoutUnknown)))
		throw new TypeError("unknown deployment request fields");
	if (message.workBindingVersion !== WORK_BINDING_VERSION)
		throw new TypeError("unsupported or incomplete work binding version");
	if (
		!message.yard?.[YARD_LAYOUT_FIELD] ||
		!message.bindleRequirements ||
		(message.camp !== undefined && !message.camp.layout)
	)
		throw new TypeError("incomplete deployment request");
	if (
		message.spendEstimateUsd === undefined ||
		!Number.isFinite(message.spendEstimateUsd) ||
		message.spendEstimateUsd < 0
	)
		throw new TypeError(
			"spendEstimateUsd must be present, finite, and nonnegative",
		);
	if (
		!selectionMode(message.yard.selectionMode) ||
		(message.camp !== undefined && !selectionMode(message.camp.selectionMode))
	)
		throw new TypeError("invalid placement selection mode");
	if (!message.ownerTenantId || !message.objective || !message.yard.requestId)
		throw new TypeError(
			"tenant, objective, and Yard request identity are required",
		);
	if (!REQUEST_DIGEST.test(message.requestDigest))
		throw new TypeError("invalid request digest");
	const yardLayout = message.yard[YARD_LAYOUT_FIELD];
	const raw = {
		schemaVersion: message.schemaVersion,
		requestId: message.requestId,
		bindleName: message.bindleName,
		manifestHash: message.manifestHash,
		bindleRequirements: {
			require: message.bindleRequirements.require,
			prefer: message.bindleRequirements.prefer,
			runtimes: message.bindleRequirements.runtimes,
			labels: message.bindleRequirements.labels,
		},
		yard: {
			requestId: message.yard.requestId,
			selectionMode: message.yard.selectionMode,
			...(message.yard.requestedYardId !== undefined
				? { requestedYardId: message.yard.requestedYardId }
				: undefined),
			requestedLayout: {
				...(yardLayout.providerId
					? { providerId: yardLayout.providerId }
					: undefined),
				...(yardLayout.runtimeId
					? { runtimeId: yardLayout.runtimeId }
					: undefined),
				regions: yardLayout.regions,
				require: yardLayout.require,
				prefer: yardLayout.prefer,
				residency: yardLayout.residency,
				isolation: yardLayout.isolation,
				network: yardLayout.network,
				componentHosts: yardLayout.componentHosts,
				labels: yardLayout.labels,
				properties: yardLayout.properties ?? {},
				camps: yardLayout.camps.map(campLayout),
			},
			bindleManifestHash: message.yard.bindleManifestHash,
			bindleRequirementsHash: message.yard.bindleRequirementsHash,
			allowGenerationRequested: message.yard.allowGenerationRequested,
		},
		...(message.camp?.layout
			? {
					camp: {
						selectionMode: message.camp.selectionMode,
						...(message.camp.campId !== undefined
							? { campId: message.camp.campId }
							: undefined),
						layout: campLayout(message.camp.layout),
					},
				}
			: undefined),
		objective: message.objective,
		spendEstimateUsd: message.spendEstimateUsd,
		ownerTenantId: message.ownerTenantId,
		resources: message.resources.map((resource) => ({
			resourceId: resource.resourceId,
			port: resource.port,
			features: resource.features,
			...(resource.region !== undefined
				? { region: resource.region }
				: undefined),
		})),
	};
	const request = parseBindleDeploymentRequest(cloneAsJson(raw));
	const digest = contentHashOf(request);
	if (digest !== contentHashOf(raw) || digest !== message.requestDigest)
		throw new TypeError(
			"deployment request digest mismatch or noncanonical fields",
		);
	return request;
}
