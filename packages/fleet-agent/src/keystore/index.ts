/**
 * Device key stores (L10, design §6.4 and §7.3). Signatures frozen by the
 * fleet contract commit (ADR-0182).
 *
 * Both stores keep their files in one key directory (`HOBO_FLEET_HOME`):
 * `operational.json` (the SIGN and SEAL private keys), `state.json` (the
 * `AgentState`, including `pendingReceipts`) and, for the file store only,
 * `identity.pem`. The directory rules are in `directory.ts`.
 */
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import type { AgentState, DeviceKeys, KeyStore } from "@hobo/fleet";
import {
	decodeOperationalKeys,
	deviceKeysOf,
	encodeOperationalKeys,
	generateOperationalKeys,
	type Identity,
	type OperationalKeys,
	publicJwkOf,
	signingWith,
} from "./device-keys.js";
import {
	prepareKeyDirectory,
	readPrivateFile,
	removePrivateFile,
	writePrivateFile,
} from "./directory.js";
import {
	destroyExternalIdentity,
	externalIdentity,
} from "./external-signer.js";
import {
	decodeAgentState,
	emptyAgentState,
	encodeAgentState,
} from "./state.js";

const IDENTITY_FILE = "identity.pem";
const OPERATIONAL_FILE = "operational.json";
const STATE_FILE = "state.json";

/** Where the identity key lives and how it is created and removed. */
type IdentitySource = Readonly<{
	held: boolean;
	load(directory: string): Promise<Identity>;
	destroy(directory: string): Promise<void>;
}>;

type Opened = Readonly<{
	identity: Identity;
	operational: OperationalKeys;
	keys: DeviceKeys;
}>;

async function loadOperational(directory: string): Promise<OperationalKeys> {
	const path = join(directory, OPERATIONAL_FILE);
	const text = await readPrivateFile(path);
	if (text !== undefined) return decodeOperationalKeys(text);
	const fresh = generateOperationalKeys();
	await writePrivateFile(path, encodeOperationalKeys(fresh));
	return fresh;
}

function directoryKeyStore(home: string, source: IdentitySource): KeyStore {
	let opening: Promise<Opened> | undefined;

	const openOnce = (): Promise<Opened> => {
		if (opening !== undefined) return opening;
		const attempt = (async () => {
			const directory = await prepareKeyDirectory(home);
			const identity = await source.load(directory);
			const operational = await loadOperational(directory);
			return Object.freeze({
				identity,
				operational,
				keys: deviceKeysOf(identity, operational, source.held),
			});
		})();
		opening = attempt;
		attempt.catch(() => {
			if (opening === attempt) opening = undefined;
		});
		return attempt;
	};

	return Object.freeze({
		async open(): Promise<DeviceKeys> {
			return (await openOnce()).keys;
		},
		async readState(): Promise<AgentState> {
			const directory = await prepareKeyDirectory(home);
			const text = await readPrivateFile(join(directory, STATE_FILE));
			return text === undefined ? emptyAgentState() : decodeAgentState(text);
		},
		async writeState(next: AgentState): Promise<void> {
			const directory = await prepareKeyDirectory(home);
			await writePrivateFile(
				join(directory, STATE_FILE),
				encodeAgentState(next),
			);
		},
		async rotateOperational(): Promise<DeviceKeys> {
			const current = await openOnce();
			const directory = await prepareKeyDirectory(home);
			const operational = generateOperationalKeys();
			await writePrivateFile(
				join(directory, OPERATIONAL_FILE),
				encodeOperationalKeys(operational),
			);
			const rotated: Opened = Object.freeze({
				identity: current.identity,
				operational,
				keys: deviceKeysOf(current.identity, operational, source.held),
			});
			opening = Promise.resolve(rotated);
			return rotated.keys;
		},
		async destroy(): Promise<void> {
			opening = undefined;
			const directory = await prepareKeyDirectory(home);
			await source.destroy(directory);
			await removePrivateFile(join(directory, OPERATIONAL_FILE));
			await removePrivateFile(join(directory, STATE_FILE));
		},
	} satisfies KeyStore);
}

function fileIdentity(): IdentitySource {
	return Object.freeze({
		held: false,
		async load(directory: string): Promise<Identity> {
			const path = join(directory, IDENTITY_FILE);
			let text = await readPrivateFile(path);
			if (text === undefined) {
				// EC P-256, the one curve hardware keystores also offer (§6.4, E18).
				const created = generateKeyPairSync("ec", { namedCurve: "P-256" });
				text = String(
					created.privateKey.export({ type: "pkcs8", format: "pem" }),
				);
				await writePrivateFile(path, text);
			}
			const privateKey = createPrivateKey(text);
			if (
				privateKey.asymmetricKeyType !== "ed25519" &&
				!(
					privateKey.asymmetricKeyType === "ec" &&
					privateKey.asymmetricKeyDetails?.namedCurve === "prime256v1"
				)
			)
				throw new Error(
					`the identity key file holds a ${privateKey.asymmetricKeyType} key; it must be EC P-256 or Ed25519`,
				);
			return Object.freeze({
				jwk: publicJwkOf(privateKey),
				sign: signingWith(privateKey),
			});
		},
		async destroy(directory: string): Promise<void> {
			await removePrivateFile(join(directory, IDENTITY_FILE));
		},
	});
}

function externalSignerIdentity(command: readonly string[]): IdentitySource {
	return Object.freeze({
		held: true,
		load: () => externalIdentity(command),
		destroy: () => destroyExternalIdentity(command),
	});
}

/** Keys and agent state in a private directory under `home`. */
export function createFileKeyStore(home: string): KeyStore {
	return directoryKeyStore(home, fileIdentity());
}

/** Keys held behind an external signer `command`; agent state under `home`. */
export function createExternalSignerKeyStore(
	home: string,
	command: readonly string[],
): KeyStore {
	if (command.length === 0 || command[0] === "")
		throw new Error("the external signer needs a command");
	return directoryKeyStore(home, externalSignerIdentity([...command]));
}
