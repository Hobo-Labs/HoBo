import * as Domain from "@alchemy.run/domain";
import {
	createSqliteDomainPlatform,
	type SqliteDomainPlatformOptions,
	type SqliteDriver,
} from "@hobo/storage-sqlite";
import * as Layer from "effect/Layer";
import { CiFleet, CiFleetHandlers } from "../domain/index.js";
import type { RunnerBackendService } from "./rivet.js";

export {
	type AcquireCiLeaseInput,
	type CiFleetRivetHostOptions,
	type CiStationLeaseEvent,
	type CiStationLeaseRecord,
	type CiStationLeaseRegistryOptions,
	type CiStationLeaseStatus,
	type CompleteCiLeaseInput,
	createCiFleetRivetLayer,
	createCiStationLeaseRegistry,
	type RunnerBackendService,
} from "./rivet.js";

export function createCiFleetInMemoryLayer<BackendErr, BackendReq>(
	runnerBackend: Layer.Layer<RunnerBackendService, BackendErr, BackendReq>,
) {
	return CiFleet.layer(CiFleetHandlers).pipe(
		Layer.provide(Layer.merge(Domain.InMemory, runnerBackend)),
	);
}

export function createCiFleetSqliteLayer<BackendErr, BackendReq>(
	driver: SqliteDriver,
	runnerBackend: Layer.Layer<RunnerBackendService, BackendErr, BackendReq>,
	options?: SqliteDomainPlatformOptions,
) {
	return CiFleet.layer(CiFleetHandlers).pipe(
		Layer.provide(
			Layer.merge(createSqliteDomainPlatform(driver, options), runnerBackend),
		),
	);
}
