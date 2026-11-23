import { create, toJson } from "@bufbuild/protobuf";
import type { CredentialResolver } from "@hobo/cd";
import type { CommandResult } from "@hobo/cli";
import type { HttpTransport } from "@hobo/core";
import {
	HostingerFleetError,
	type HostingerFleetMachine,
	hostingerVpsFleet,
	parseHostingerVmPowerAction,
} from "@hobo/provider-hostinger";

import {
	type CiFleetHost,
	CiFleetHostSchema,
	CiFleetPowerActionSchema,
	CiFleetStatusSchema,
} from "./_generated/ci_fleet_pb.js";

// public-contract: the owner-store reference hobo ci fleet reads the Hostinger API token from; owners store it under this name.
export const CI_FLEET_TOKEN_REF = "owner://HOSTINGER_API_TOKEN";
// public-contract: the env-scheme alias of the same owner-store entry, accepted for owners who named it that way.
export const CI_FLEET_TOKEN_ENV_REF = "env://HOSTINGER_API_TOKEN";
const CREDENTIAL_SCOPE = "hobo-ci-fleet";
const FLEET_PROVIDER = "hostinger";
const MACHINE_TARGET = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/u;

const FLEET_USAGE =
	"Use hobo ci fleet status, hobo ci fleet restart <vm> or hobo ci fleet start <vm> (<vm> is a Hostinger machine id or hostname).";

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

function credentialUnavailable(): CommandResult {
	return {
		ok: false,
		status: "credential_unavailable",
		code: "HOBO_CI_FLEET_CREDENTIAL_UNAVAILABLE",
		message: `hobo ci fleet needs ${CI_FLEET_TOKEN_REF} from the owner's store session, and none resolved. Run HoBo MCP's choose_secret_store to connect the owner's store, then ask again.`,
		remediation: [
			"Call the HoBo MCP tool choose_secret_store for this project directory.",
			`Have the owner store the Hostinger API token in that store under ${CI_FLEET_TOKEN_REF.slice("owner://".length)}.`,
		],
	};
}

async function resolveFleetToken(
	credentials: CredentialResolver,
): Promise<string | undefined> {
	for (const ref of [CI_FLEET_TOKEN_REF, CI_FLEET_TOKEN_ENV_REF]) {
		const material = await credentials
			.resolve(ref, CREDENTIAL_SCOPE)
			.catch(() => undefined);
		const token = material?.token;
		if (token !== undefined && token !== "") return token;
	}
	return undefined;
}

function hostOf(machine: HostingerFleetMachine): CiFleetHost {
	return create(CiFleetHostSchema, {
		provider: FLEET_PROVIDER,
		id: machine.id,
		hostname: machine.hostname,
		state: machine.state,
		plan: machine.plan ?? "",
		ipv4: machine.ipv4 ?? "",
		actionsLock: machine.actionsLock ?? "",
	});
}

function hostLine(host: CiFleetHost): string {
	return [
		host.id,
		host.hostname === "" ? "(no hostname)" : host.hostname,
		host.state,
		host.plan === "" ? "(no plan)" : host.plan,
		host.actionsLock === "locked" ? "action in progress" : "",
	]
		.filter((cell) => cell !== "")
		.join("  ");
}

function scrubbed(text: string, token: string): string {
	return text.split(token).join("[redacted]");
}

export async function runCiFleet(input: {
	readonly positionals: readonly string[];
	readonly credentials: CredentialResolver | undefined;
	readonly transport: HttpTransport;
}): Promise<CommandResult> {
	const [verb, target, ...rest] = input.positionals;
	const action =
		verb === "status" ? "status" : parseHostingerVmPowerAction(verb ?? "");
	if (action === undefined || rest.length > 0) return usage(FLEET_USAGE);
	if (action === "status" && target !== undefined) return usage(FLEET_USAGE);
	if (
		action !== "status" &&
		(target === undefined || !MACHINE_TARGET.test(target))
	)
		return usage(FLEET_USAGE);
	if (input.credentials === undefined) return credentialUnavailable();
	const token = await resolveFleetToken(input.credentials);
	if (token === undefined) return credentialUnavailable();
	const fleet = hostingerVpsFleet({
		transport: input.transport,
		resolveToken: async () => token,
	});
	try {
		if (action === "status") {
			const hosts = (await fleet.list()).map(hostOf);
			const status = create(CiFleetStatusSchema, {
				provider: FLEET_PROVIDER,
				hosts,
			});
			return {
				message:
					hosts.length === 0
						? "The Hostinger account has no virtual machines."
						: [
								`Hostinger fleet: ${hosts.length} machine${hosts.length === 1 ? "" : "s"}`,
								...hosts.map(hostLine),
							].join("\n"),
				data: {
					fleet: toJson(CiFleetStatusSchema, status, {
						alwaysEmitImplicit: true,
					}),
				},
			};
		}
		const receipt = await fleet.power(target ?? "", action);
		const record = create(CiFleetPowerActionSchema, {
			provider: FLEET_PROVIDER,
			host: hostOf(receipt.machine),
			action: receipt.action,
			actionId: receipt.actionId,
			actionState: receipt.actionState,
		});
		return {
			message: `Hostinger accepted ${receipt.action} of machine ${receipt.machine.id} (${receipt.machine.hostname || "no hostname"}): action ${receipt.actionId} is ${receipt.actionState}. Run hobo ci fleet status to watch it settle.`,
			data: {
				fleetAction: toJson(CiFleetPowerActionSchema, record, {
					alwaysEmitImplicit: true,
				}),
			},
		};
	} catch (error) {
		if (error instanceof HostingerFleetError)
			return {
				ok: false,
				status:
					error.code === "HOSTINGER_FLEET_REJECTED"
						? "provider_error"
						: "refused",
				code: error.code,
				message: scrubbed(error.message, token),
			};
		return {
			ok: false,
			status: "provider_error",
			code: "HOBO_CI_FLEET_FAILED",
			message: scrubbed(
				error instanceof Error ? error.message : "the Hostinger call failed",
				token,
			),
		};
	}
}
