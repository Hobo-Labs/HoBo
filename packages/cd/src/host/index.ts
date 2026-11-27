import * as Domain from "@alchemy.run/domain";
import {
	createSqliteDomainPlatform,
	type SqliteDomainPlatformOptions,
	type SqliteDriver,
} from "@hobo/storage-sqlite";
import * as Layer from "effect/Layer";
import { CdRelease, CdReleaseHandlers } from "../domain/index.js";
import {
	type CdCampRealizerService,
	type CdDeliveryFlowService,
	type CdVerificationGateService,
	DefaultFailClosedDeliveryFlowLayer,
} from "./rivet.js";

export {
	type CdDeliveryFlowAdapter,
	createCdDeliveryFlowRouterLayer,
} from "./flow-router.js";
export {
	type CdCampRealizerService,
	type CdDeliveryFlowService,
	type CdPromotionGateEvent,
	type CdPromotionGateRecord,
	type CdPromotionGateRegistryOptions,
	type CdPromotionGateStatus,
	type CdPullWatchEvent,
	type CdPullWatchKind,
	type CdPullWatchRecord,
	type CdPullWatchResolutionStatus,
	type CdPullWatchStatus,
	type CdReleaseRivetHostOptions,
	type CdVerificationGateService,
	createCdPromotionGateRegistry,
	createCdPullWatchRegistry,
	createCdReleaseRivetLayer,
	DefaultFailClosedDeliveryFlowLayer,
	type OpenCdPromotionGateInput,
	type RegisterCdPullWatchInput,
	type ResolveCdPromotionGateInput,
	type ResolveCdPullWatchInput,
} from "./rivet.js";

export function createCdReleaseInMemoryLayer<
	RealizerErr,
	RealizerReq,
	GateErr,
	GateReq,
	FlowErr = never,
	FlowReq = never,
>(
	realizer: Layer.Layer<CdCampRealizerService, RealizerErr, RealizerReq>,
	verificationGate: Layer.Layer<CdVerificationGateService, GateErr, GateReq>,
	deliveryFlow?: Layer.Layer<CdDeliveryFlowService, FlowErr, FlowReq>,
) {
	const flowLayer = deliveryFlow ?? DefaultFailClosedDeliveryFlowLayer;
	return CdRelease.layer(CdReleaseHandlers).pipe(
		Layer.provide(
			Layer.mergeAll(Domain.InMemory, realizer, verificationGate, flowLayer),
		),
	);
}

export function createCdReleaseSqliteLayer<
	RealizerErr,
	RealizerReq,
	GateErr,
	GateReq,
	FlowErr = never,
	FlowReq = never,
>(
	driver: SqliteDriver,
	realizer: Layer.Layer<CdCampRealizerService, RealizerErr, RealizerReq>,
	verificationGate: Layer.Layer<CdVerificationGateService, GateErr, GateReq>,
	options?: SqliteDomainPlatformOptions,
	deliveryFlow?: Layer.Layer<CdDeliveryFlowService, FlowErr, FlowReq>,
) {
	const flowLayer = deliveryFlow ?? DefaultFailClosedDeliveryFlowLayer;
	return CdRelease.layer(CdReleaseHandlers).pipe(
		Layer.provide(
			Layer.mergeAll(
				createSqliteDomainPlatform(driver, options),
				realizer,
				verificationGate,
				flowLayer,
			),
		),
	);
}
