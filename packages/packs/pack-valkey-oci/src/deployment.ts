/**
 * From a verified manifest plus a parsed configuration to a container spec.
 *
 * The whole server configuration is rendered here as a config **file**, not as a
 * pile of `--flag value` argv elements. Two reasons: the file is one artifact a
 * human can read and a receipt can hash, and it gives the password somewhere to
 * live that is neither argv nor the environment.
 *
 * The password reaches the server through an `include`d file that custody writes.
 * `valkey-server --requirepass <value>` would put it in argv, where `ps` shows it
 * to every process on the host; an environment variable would put it in
 * `/proc/<pid>/environ` and in `docker inspect`. The include is the only one of
 * the three that keeps it out of both.
 */
import type { SecretRef } from "@hobo/bindings";
import {
	PackError,
	type PackProbes,
	type PackVolumeBinding,
	type ParsedPackConfiguration,
	type VerifiedPackManifest,
} from "@hobo/pack-framework";

import {
	VALKEY_CONFIG_PATH,
	VALKEY_DATA_MOUNT_PATH,
	VALKEY_PORT,
	VALKEY_REQUIREPASS_INCLUDE_PATH,
} from "./image.js";
import { VALKEY_DATA_VOLUME, VALKEY_PACK_ID } from "./manifest.js";
import {
	isValkeyDurabilityMode,
	isValkeyEvictionPolicy,
	type ValkeyDurabilityMode,
	type ValkeyEvictionPolicy,
	type ValkeyRetentionSemantics,
	valkeyRetentionSemantics,
} from "./semantics.js";

/**
 * How the executor must materialise a secret file.
 *
 * `valkey-conf-requirepass` means "write `requirepass <value>` and nothing else".
 * Naming the format instead of shipping a template string keeps the interpolation
 * on the side of the boundary that actually holds the material.
 */
export type ValkeySecretFileFormat = "valkey-conf-requirepass";

export type ValkeySecretFileMount = {
	readonly path: string;
	readonly secretRef: SecretRef;
	readonly format: ValkeySecretFileFormat;
	/** Octal file mode. Owner-read only for credential material. */
	readonly mode: "0400";
};

export type ValkeyConfigFile = {
	readonly path: string;
	readonly contents: string;
};

export type ValkeyVolumeMount = {
	readonly volumeName: string;
	readonly mountPath: string;
	readonly binding: PackVolumeBinding;
};

export type ValkeyContainerSpec = {
	readonly packId: typeof VALKEY_PACK_ID;
	readonly image: string;
	readonly architecture: string;
	readonly command: readonly string[];
	/** Non-secret environment only — and for this pack, empty. */
	readonly env: Readonly<Record<string, string>>;
	readonly configFiles: readonly ValkeyConfigFile[];
	readonly secretFiles: readonly ValkeySecretFileMount[];
	readonly volumeMounts: readonly ValkeyVolumeMount[];
	readonly ports: readonly {
		readonly name: string;
		readonly containerPort: number;
	}[];
	readonly probes: PackProbes;
	readonly resources: VerifiedPackManifest["resourceBounds"];
	/**
	 * The durability and eviction facts this spec actually implements.
	 *
	 * Carried on the spec so a receipt records what was deployed rather than what
	 * someone later reads off a config file.
	 */
	readonly retention: ValkeyRetentionSemantics;
};

/** `save` schedules per durability mode. Empty means snapshots are off. */
function saveDirectives(mode: ValkeyDurabilityMode): readonly string[] {
	switch (mode) {
		case "none":
			// An explicit empty `save` is required: the shipped default config
			// saves on a schedule, so silence here would mean snapshots.
			return ['save ""'];
		case "rdb-snapshots":
			// 60s/1000 changes is the tightest of the stock schedules, and it is
			// what the 60s worst-case loss figure in `semantics.ts` refers to.
			return ["save 900 1", "save 300 10", "save 60 1000"];
		case "aof-everysec":
		case "aof-always":
			// The AOF is the durability mechanism; a snapshot on top of it would
			// double the write amplification for no additional guarantee.
			return ['save ""'];
	}
}

function appendOnlyDirectives(mode: ValkeyDurabilityMode): readonly string[] {
	switch (mode) {
		case "none":
		case "rdb-snapshots":
			return ["appendonly no"];
		case "aof-everysec":
			return ["appendonly yes", "appendfsync everysec"];
		case "aof-always":
			return ["appendonly yes", "appendfsync always"];
	}
}

function renderConfig(input: {
	readonly durabilityMode: ValkeyDurabilityMode;
	readonly evictionPolicy: ValkeyEvictionPolicy;
	readonly maxmemoryBytes: number;
	readonly databases: number;
}): string {
	const lines = [
		"# Rendered by @hobo/pack-valkey-oci. Do not edit in place: the pack",
		"# regenerates this file from the deployment configuration, and a manual",
		"# edit would be lost on the next apply and invisible in the receipt.",
		`port ${VALKEY_PORT}`,
		`dir ${VALKEY_DATA_MOUNT_PATH}`,
		`databases ${input.databases}`,
		// Bind to every interface *inside the container*; the port's exposure is
		// a Camp-level decision, not a listener-level one.
		"bind 0.0.0.0",
		// Belt and braces: protected mode already refuses external commands
		// without a password, and this pack always sets one.
		"protected-mode yes",
		`maxmemory ${input.maxmemoryBytes}`,
		`maxmemory-policy ${input.evictionPolicy}`,
		...saveDirectives(input.durabilityMode),
		...appendOnlyDirectives(input.durabilityMode),
		// Last line on purpose: in a Valkey config file the later directive wins,
		// so an include at the end cannot be overridden by anything above it.
		`include ${VALKEY_REQUIREPASS_INCLUDE_PATH}`,
	];
	return `${lines.join("\n")}\n`;
}

export function buildValkeyContainerSpec(
	manifest: VerifiedPackManifest,
	config: ParsedPackConfiguration,
): ValkeyContainerSpec {
	if (manifest.packId !== VALKEY_PACK_ID) {
		throw new PackError(
			"PACK_MANIFEST_INVALID",
			`expected ${VALKEY_PACK_ID}, received ${manifest.packId}`,
		);
	}

	const volumeName = config.requireString("dataVolume");
	if (volumeName !== VALKEY_DATA_VOLUME) {
		throw new PackError(
			"PACK_PERSISTENCE_REQUIRED",
			`dataVolume must name the declared volume ${VALKEY_DATA_VOLUME}`,
			{ detail: { supplied: volumeName } },
		);
	}
	// Throws PACK_PERSISTENCE_REQUIRED when nothing is bound.
	const binding = config.requireVolumeBinding(volumeName);
	if (binding.storage.kind !== "local-volume") {
		throw new PackError(
			"PACK_PERSISTENCE_REQUIRED",
			"an RDB or AOF is written with ordinary file semantics; bind a local volume rather than object storage",
			{ detail: { kind: binding.storage.kind } },
		);
	}

	const durabilityMode = config.requireString("durabilityMode");
	if (!isValkeyDurabilityMode(durabilityMode)) {
		throw new PackError(
			"PACK_CONFIGURATION_INVALID",
			`unknown durabilityMode ${JSON.stringify(durabilityMode)}`,
		);
	}
	const evictionPolicy = config.requireString("evictionPolicy");
	if (!isValkeyEvictionPolicy(evictionPolicy)) {
		throw new PackError(
			"PACK_CONFIGURATION_INVALID",
			`unknown evictionPolicy ${JSON.stringify(evictionPolicy)}`,
		);
	}

	const maxmemoryBytes = config.requireInteger("maxmemoryBytes");
	const databases = config.requireInteger("databases");
	const passwordRef = config.requireSecretRef("authPasswordRef");

	return {
		packId: VALKEY_PACK_ID,
		image: manifest.selectedImage.reference.ref,
		architecture: manifest.selectedArchitecture,
		// The image's own entrypoint runs `valkey-server`; the config path is the
		// single positional argument it takes.
		command: ["valkey-server", VALKEY_CONFIG_PATH],
		// Empty on purpose. Nothing this pack needs to say belongs in an
		// environment variable, and an empty map is a stronger statement than an
		// absent field.
		env: {},
		configFiles: [
			{
				path: VALKEY_CONFIG_PATH,
				contents: renderConfig({
					durabilityMode,
					evictionPolicy,
					maxmemoryBytes,
					databases,
				}),
			},
		],
		secretFiles: [
			{
				path: VALKEY_REQUIREPASS_INCLUDE_PATH,
				secretRef: passwordRef,
				format: "valkey-conf-requirepass",
				mode: "0400",
			},
		],
		volumeMounts: [{ volumeName, mountPath: VALKEY_DATA_MOUNT_PATH, binding }],
		ports: [{ name: "valkey", containerPort: VALKEY_PORT }],
		probes: manifest.probes,
		resources: manifest.resourceBounds,
		retention: valkeyRetentionSemantics({ durabilityMode, evictionPolicy }),
	};
}
