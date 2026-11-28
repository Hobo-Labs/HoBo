import { Buffer } from "node:buffer";
import { fromBinary, fromJsonString, toBinary } from "@bufbuild/protobuf";
import {
	BindleDeploymentRequestSchema,
	type CampPlacementLayout,
	type PlacementLabelEntry,
} from "../_generated/yard_placement_pb.js";
import { cloneAsJson, isJsonObject, parseJsonValue } from "../json.js";
import { parseBindleDeploymentRequest } from "./deploy.js";
import {
	type BindleDeploymentRequest,
	type CampLayout,
	contentHashOf,
	type YardSelectionMode,
} from "./types.js";

const REQUEST_DIGEST = /^sha256:[0-9a-f]{64}$/;
const YARD_LAYOUT_FIELD = "requestedShape";

function selectionMode(value: string): value is YardSelectionMode {
	return (
		value === "exact" ||
		value === "compatible" ||
		value === "compatible-or-generate"
	);
}

function labelEntries(labels: Readonly<Record<string, string>>) {
	return Object.entries(labels).map(([key, value]) => ({ key, value }));
}

function readLabels(entries: readonly PlacementLabelEntry[]) {
	const seen = new Set<string>();
	for (const entry of entries) {
		if (seen.has(entry.key)) throw new TypeError("duplicate placement label");
		seen.add(entry.key);
	}
	return Object.fromEntries(entries.map(({ key, value }) => [key, value]));
}

function wireCampLayout(layout: CampLayout) {
	const { labels, ...rest } = layout;
	return { ...rest, canonicalLabels: labelEntries(labels) };
}

function campLayout(layout: CampPlacementLayout) {
	return {
		...(layout.id !== undefined ? { id: layout.id } : undefined),
		...(layout.env !== undefined ? { env: layout.env } : undefined),
		...(layout.envType !== undefined ? { envType: layout.envType } : undefined),
		require: layout.require,
		prefer: layout.prefer,
		labels: readLabels(layout.canonicalLabels),
		runtimeRequirements: layout.runtimeRequirements,
	};
}

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
	const { yard, bindleRequirements, camp, ...rest } = normalized;
	const { requestedLayout, ...yardFields } = yard;
	const { labels, properties, camps, ...layoutFields } = requestedLayout;
	const { labels: bindleLabels, ...requirementFields } = bindleRequirements;
	const message = fromJsonString(
		BindleDeploymentRequestSchema,
		JSON.stringify({
			...rest,
			yard: {
				...yardFields,
				[YARD_LAYOUT_FIELD]: {
					...layoutFields,
					canonicalLabels: labelEntries(labels),
					propertiesJson: JSON.stringify(properties),
					camps: camps.map(wireCampLayout),
				},
			},
			bindleRequirements: {
				...requirementFields,
				canonicalLabels: labelEntries(bindleLabels),
			},
			...(camp
				? { camp: { ...camp, layout: wireCampLayout(camp.layout) } }
				: undefined),
			requestDigest: contentHashOf(normalized),
		}),
	);
	const bytes = toBinary(BindleDeploymentRequestSchema, message);
	decodeBindleDeploymentRequest(bytes);
	return bytes;
}

export function decodeBindleDeploymentRequest(
	bytes: Uint8Array,
): BindleDeploymentRequest {
	const message = fromBinary(BindleDeploymentRequestSchema, bytes);
	const withUnknown = toBinary(BindleDeploymentRequestSchema, message);
	const withoutUnknown = toBinary(BindleDeploymentRequestSchema, message, {
		writeUnknownFields: false,
	});
	if (!Buffer.from(withUnknown).equals(Buffer.from(withoutUnknown)))
		throw new TypeError("unknown deployment request fields");
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
	if (yardLayout.propertiesJson === undefined)
		throw new TypeError("placement properties must be present");
	const properties = parseJsonValue(yardLayout.propertiesJson);
	if (
		!isJsonObject(properties) ||
		JSON.stringify(properties) !== yardLayout.propertiesJson
	)
		throw new TypeError(
			"placement properties must be canonical JSON object text",
		);
	const raw = {
		schemaVersion: message.schemaVersion,
		requestId: message.requestId,
		bindleName: message.bindleName,
		manifestHash: message.manifestHash,
		bindleRequirements: {
			require: message.bindleRequirements.require,
			prefer: message.bindleRequirements.prefer,
			runtimes: message.bindleRequirements.runtimes,
			labels: readLabels(message.bindleRequirements.canonicalLabels),
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
				labels: readLabels(yardLayout.canonicalLabels),
				properties,
				camps: yardLayout.camps.map((item) => campLayout(item)),
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
