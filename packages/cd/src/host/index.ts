import * as Domain from "@alchemy.run/domain";
import {
	createSqliteDomainPlatform,
	type SqliteDomainPlatformOptions,
	type SqliteDriver,
} from "@hobo/storage-sqlite";
import * as Layer from "effect/Layer";
import { CdRelease, CdReleaseHandlers } from "../domain/index.js";
import type {
	CdCampRealizerService,
	CdVerificationGateService,
} from "./rivet.js";

export {
	type CdCampRealizerService,
	type CdPromotionGateEvent,
	type CdPromotionGateRecord,
	type CdPromotionGateRegistryOptions,
	type CdPromotionGateStatus,
	type CdReleaseRivetHostOptions,
	type CdVerificationGateService,
	createCdPromotionGateRegistry,
	createCdReleaseRivetLayer,
	type OpenCdPromotionGateInput,
	type ResolveCdPromotionGateInput,
} from "./rivet.js";

export function createCdReleaseInMemoryLayer<
	RealizerErr,
	RealizerReq,
	GateErr,
	GateReq,
>(
	realizer: Layer.Layer<CdCampRealizerService, RealizerErr, RealizerReq>,
	verificationGate: Layer.Layer<CdVerificationGateService, GateErr, GateReq>,
) {
	return CdRelease.layer(CdReleaseHandlers).pipe(
		Layer.provide(Layer.mergeAll(Domain.InMemory, realizer, verificationGate)),
	);
}

export function createCdReleaseSqliteLayer<
	RealizerErr,
	RealizerReq,
	GateErr,
	GateReq,
>(
	driver: SqliteDriver,
	realizer: Layer.Layer<CdCampRealizerService, RealizerErr, RealizerReq>,
	verificationGate: Layer.Layer<CdVerificationGateService, GateErr, GateReq>,
	options?: SqliteDomainPlatformOptions,
) {
	return CdRelease.layer(CdReleaseHandlers).pipe(
		Layer.provide(
			Layer.mergeAll(
				createSqliteDomainPlatform(driver, options),
				realizer,
				verificationGate,
			),
		),
	);
}
