/**
 * Operations: key ceremony, rotation, backup and restore (L27).
 * Signatures frozen by the fleet contract commit (ADR-0182). Called by
 * `hobo fleet ops …` and by the authority service.
 */
import {
	type Clock,
	type FleetLog,
	FleetNotImplemented,
	type Outcome,
} from "@hobo/fleet";
import type { SecretsPort } from "@hobo/identity";
import { ceremony } from "./ceremony.js";
import { readOpsConfig } from "./config.js";

export type OpsContext = Readonly<{
	configPath: string;
	secrets: SecretsPort;
	now: Clock;
	log: FleetLog;
}>;

export type RotatableKey =
	| "operator-signing"
	| "account-signing"
	| "scoped-observer"
	| "scoped-executor"
	| "scoped-dispatcher"
	| "token-signing"
	| "record-signing"
	| "witness";

/** Generates the NATS operator identity key offline and returns it as two shares. */
export function runCeremony(
	context: OpsContext,
): Promise<
	Outcome<
		Readonly<{ operatorPublicKey: string; shares: readonly [string, string] }>
	>
> {
	return readOpsConfig(context.configPath).then((config) =>
		config.ok
			? ceremony({
					secrets: context.secrets,
					prefix: config.value.secretPrefix,
					operatorName: config.value.operatorName,
					now: context.now,
					log: context.log,
				})
			: config,
	);
}

/** Add, publish, switch, remove. Resumable: a second call continues from the step the first reached. */
export function rotateKey(
	context: OpsContext,
	which: RotatableKey,
): Promise<
	Outcome<
		Readonly<{ reached: "add" | "publish" | "switch" | "remove" | "done" }>
	>
> {
	void context;
	void which;
	throw new FleetNotImplemented("rotateKey");
}

/** Writes the event store and the audit stream to an archive with a manifest of digests. */
export function backup(
	context: OpsContext,
	archivePath: string,
): Promise<Outcome<Readonly<{ manifestDigest: string }>>> {
	void context;
	void archivePath;
	throw new FleetNotImplemented("backup");
}

/** Loads the archive into a fresh deployment, rebuilds the buckets, increments the incarnation. */
export function restore(
	context: OpsContext,
	archivePath: string,
): Promise<Outcome<Readonly<{ incarnation: number }>>> {
	void context;
	void archivePath;
	throw new FleetNotImplemented("restore");
}
