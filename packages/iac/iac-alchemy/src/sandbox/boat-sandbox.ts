import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import {
	Agent37Sandbox,
	type Agent37SandboxRegion,
	type Agent37SandboxSize,
	Agent37Snapshot,
} from "./agent37-sandbox.js";

export type CiCdSandboxEngine = "boat" | "agent37";

export interface CiCdGoldenSnapshotSpec {
	readonly id: string;
	readonly name: string;
	readonly setupCommands: readonly string[];
	readonly cwd?: string;
	readonly size?: Agent37SandboxSize;
	readonly region?: Agent37SandboxRegion;
	readonly credentialLocator?: string;
	readonly credentialConfigKey?: string;
}

export interface CiCdForkSandboxSpec {
	readonly id: string;
	readonly name: string;
	readonly noEnv?: boolean;
	readonly labels?: readonly string[];
	readonly autoStopSeconds?: number;
	readonly forkFromSandboxId?: string;
	readonly credentialLocator?: string;
	readonly credentialConfigKey?: string;
}

export function declareBoatCiCdSnapshotAndSandbox(input: {
	readonly snapshot: CiCdGoldenSnapshotSpec;
	readonly sandbox: CiCdForkSandboxSpec;
}) {
	return Effect.gen(function* () {
		const golden = yield* Boat.Snapshot(input.snapshot.id, {
			name: input.snapshot.name,
			run: [...input.snapshot.setupCommands],
			...(input.snapshot.cwd !== undefined
				? { cwd: input.snapshot.cwd }
				: undefined),
			...(input.snapshot.size !== undefined
				? { type: input.snapshot.size }
				: undefined),
		});
		const sandbox = yield* Boat.Sandbox(input.sandbox.id, {
			name: input.sandbox.name,
			snapshot: golden,
			noEnv: input.sandbox.noEnv ?? true,
			snapshots: true,
			autoStop: `${input.sandbox.autoStopSeconds ?? 300} seconds`,
		});
		return {
			engine: "boat" as const,
			snapshotName: golden.name,
			sandboxId: sandbox.sandboxId,
		};
	});
}

export function declareAgent37CiCdSnapshotAndSandbox(input: {
	readonly snapshot: CiCdGoldenSnapshotSpec;
	readonly sandbox: CiCdForkSandboxSpec;
}) {
	return Effect.gen(function* () {
		const golden = yield* Agent37Snapshot(input.snapshot.id, {
			name: input.snapshot.name,
			run: input.snapshot.setupCommands,
			...(input.snapshot.cwd !== undefined
				? { cwd: input.snapshot.cwd }
				: undefined),
			...(input.snapshot.size !== undefined
				? { size: input.snapshot.size }
				: undefined),
			...(input.snapshot.region !== undefined
				? { region: input.snapshot.region }
				: undefined),
			...(input.snapshot.credentialLocator !== undefined
				? { credentialLocator: input.snapshot.credentialLocator }
				: undefined),
			...(input.snapshot.credentialConfigKey !== undefined
				? { credentialConfigKey: input.snapshot.credentialConfigKey }
				: undefined),
		});
		const sandbox = yield* Agent37Sandbox(input.sandbox.id, {
			name: input.sandbox.name,
			snapshot: golden,
			noEnv: input.sandbox.noEnv ?? true,
			...(input.sandbox.labels !== undefined
				? { labels: input.sandbox.labels }
				: undefined),
			...(input.sandbox.autoStopSeconds !== undefined
				? { autoStopSeconds: input.sandbox.autoStopSeconds }
				: undefined),
			...(input.sandbox.forkFromSandboxId !== undefined
				? { forkFromSandboxId: input.sandbox.forkFromSandboxId }
				: undefined),
			...(input.sandbox.credentialLocator !== undefined
				? { credentialLocator: input.sandbox.credentialLocator }
				: undefined),
			...(input.sandbox.credentialConfigKey !== undefined
				? { credentialConfigKey: input.sandbox.credentialConfigKey }
				: undefined),
		});
		return {
			engine: "agent37" as const,
			snapshotName: golden.name,
			sandboxId: sandbox.sandboxId,
			endpointUrl: sandbox.endpointUrl,
		};
	});
}

export { Boat };
