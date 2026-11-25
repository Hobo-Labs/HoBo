import * as Domain from "@alchemy.run/domain";
import {
	createSqliteDomainPlatform,
	type SqliteDomainPlatformOptions,
	type SqliteDriver,
} from "@hobo/storage-sqlite";
import * as Layer from "effect/Layer";
import { GhRelay, GhRelayHandlers } from "../domain/index.js";
import type { GhLintSandboxService, GhRunnerProtocolService } from "./rivet.js";

export {
	type AnswerPickRunnerInput,
	type ClaimPickRunnerInput,
	createGhPickRunnerRegistry,
	createGhRelayRivetLayer,
	type EnqueuePickRunnerInput,
	type GhLintSandboxService,
	type GhPickRunnerEvent,
	type GhPickRunnerJobRecord,
	type GhPickRunnerJobStatus,
	type GhPickRunnerRegistryOptions,
	type GhRelayRivetHostOptions,
	type GhRunnerProtocolService,
} from "./rivet.js";

export function createGhRelayInMemoryLayer<
	ProtoErr,
	ProtoReq,
	SandboxErr,
	SandboxReq,
>(externals: {
	readonly runnerProtocol: Layer.Layer<
		GhRunnerProtocolService,
		ProtoErr,
		ProtoReq
	>;
	readonly lintSandbox: Layer.Layer<
		GhLintSandboxService,
		SandboxErr,
		SandboxReq
	>;
}) {
	return GhRelay.layer(GhRelayHandlers).pipe(
		Layer.provide(
			Layer.mergeAll(
				Domain.InMemory,
				externals.runnerProtocol,
				externals.lintSandbox,
			),
		),
	);
}

export function createGhRelaySqliteLayer<
	ProtoErr,
	ProtoReq,
	SandboxErr,
	SandboxReq,
>(
	driver: SqliteDriver,
	externals: {
		readonly runnerProtocol: Layer.Layer<
			GhRunnerProtocolService,
			ProtoErr,
			ProtoReq
		>;
		readonly lintSandbox: Layer.Layer<
			GhLintSandboxService,
			SandboxErr,
			SandboxReq
		>;
	},
	options?: SqliteDomainPlatformOptions,
) {
	return GhRelay.layer(GhRelayHandlers).pipe(
		Layer.provide(
			Layer.mergeAll(
				createSqliteDomainPlatform(driver, options),
				externals.runnerProtocol,
				externals.lintSandbox,
			),
		),
	);
}
