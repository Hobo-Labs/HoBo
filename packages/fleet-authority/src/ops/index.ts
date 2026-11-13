/**
 * Operations: key ceremony, rotation, backup and restore (L27).
 * Signatures frozen by the fleet contract commit (ADR-0182). Called by
 * `hobo fleet ops …` and by the authority service.
 */
import type { Clock, FleetLog, Outcome } from "@hobo/fleet";
import type { SecretsPort } from "@hobo/identity";
import { backupArchive, restoreArchive } from "./archive.js";
import { ceremony } from "./ceremony.js";
import { type Composed, compose } from "./compose.js";
import { type OpsConfig, readOpsConfig } from "./config.js";
import { rotate } from "./rotation.js";

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
	return composed(context, async (config, parts) =>
		rotate(
			{
				secrets: context.secrets,
				prefix: config.secretPrefix,
				trust: {
					store: await parts.store(),
					bus: parts.bus,
					tenant: config.tenant,
					witnessTimeoutMs: config.witnessTimeoutMs,
					now: context.now,
					log: context.log,
				},
				nats: parts.nats,
				now: context.now,
				log: context.log,
			},
			which,
		),
	);
}

/** Writes the event store and the audit stream to an archive with a manifest of digests. */
export function backup(
	context: OpsContext,
	archivePath: string,
): Promise<Outcome<Readonly<{ manifestDigest: string }>>> {
	return composed(context, (config, parts) =>
		backupArchive(archiveDeps(context, config, parts), archivePath),
	);
}

/** Loads the archive into a fresh deployment, rebuilds the buckets, increments the incarnation. */
export function restore(
	context: OpsContext,
	archivePath: string,
): Promise<Outcome<Readonly<{ incarnation: number }>>> {
	return composed(context, (config, parts) =>
		restoreArchive(archiveDeps(context, config, parts), archivePath),
	);
}

function archiveDeps(context: OpsContext, config: OpsConfig, parts: Composed) {
	return {
		tenant: config.tenant,
		profile: config.profile,
		journal: parts.journal,
		store: parts.store,
		bus: parts.bus,
		secrets: context.secrets,
		prefix: config.secretPrefix,
		witnessTimeoutMs: config.witnessTimeoutMs,
		now: context.now,
		log: context.log,
	};
}

/** Reads the configuration, composes the deployment, runs `operation`, and closes what it opened. */
async function composed<T>(
	context: OpsContext,
	operation: (config: OpsConfig, parts: Composed) => Promise<Outcome<T>>,
): Promise<Outcome<T>> {
	const config = await readOpsConfig(context.configPath);
	if (!config.ok) return config;
	let parts: Composed | undefined;
	try {
		const made = await compose(context, config.value);
		if (!made.ok) return made;
		parts = made.value;
		return await operation(config.value, parts);
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "unavailable",
				message:
					error instanceof Error ? error.message : "the operation failed",
			},
		};
	} finally {
		await parts?.close();
	}
}
