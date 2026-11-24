import { create, toJson } from "@bufbuild/protobuf";
import type { CredentialResolver } from "@hobo/cd";
import type { CommandResult } from "@hobo/cli";
import type { HttpTransport } from "@hobo/core";
import {
	HOSTINGER_API_HOST,
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
import type {
	AgentVaultRefusal,
	AgentVaultRouter,
} from "./agent-vault-broker.js";

// public-contract: the owner-store reference hobo ci fleet reads the Hostinger API token from; owners store it under this name.
export const CI_FLEET_TOKEN_REF = "owner://HOSTINGER_API_TOKEN";
const CREDENTIAL_SCOPE = "hobo-ci-fleet";
const FLEET_PROVIDER = "hostinger";
const MACHINE_TARGET = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$/u;

const FLEET_USAGE =
	"Use hobo ci fleet status, hobo ci fleet restart <vm> or hobo ci fleet start <vm> (<vm> is a Hostinger machine id or hostname).";

function usage(message: string): CommandResult {
	return { ok: false, status: "usage", code: "HOBO_CLI_USAGE", message };
}

function credentialUnavailable(agentVault?: AgentVaultRefusal): CommandResult {
	return {
		ok: false,
		status: "credential_unavailable",
		code: "HOBO_CI_FLEET_CREDENTIAL_UNAVAILABLE",
		message: `hobo ci fleet needs ${CI_FLEET_TOKEN_REF} from the owner's store session, or an Infisical Agent Vault service for ${HOSTINGER_API_HOST}, and neither resolved.${agentVault === undefined ? "" : ` Agent Vault: ${agentVault.message}`} Run HoBo MCP's choose_secret_store to connect the owner's store, then ask again.`,
		remediation: [
			"Call the HoBo MCP tool choose_secret_store for this project directory.",
			`Have the owner store the Hostinger API token in that store under ${CI_FLEET_TOKEN_REF.slice("owner://".length)}, or keep it in an Infisical Agent Vault http service for ${HOSTINGER_API_HOST} that the signed-in Infisical identity can use.`,
			...(agentVault?.remediation ?? []),
		],
	};
}

function agentVaultRefused(refusal: AgentVaultRefusal): CommandResult {
	return {
		ok: false,
		status:
			refusal.code === "HOBO_AGENT_VAULT_PROXY_FAILED" ||
			refusal.code === "HOBO_AGENT_VAULT_FAILED"
				? "provider_error"
				: "refused",
		code: refusal.code,
		message: refusal.message,
		remediation: [...refusal.remediation],
	};
}

type FleetAccess = Readonly<{
	transport: HttpTransport;
	token: string;
	source:
		| Readonly<{ kind: "owner-store" }>
		| Readonly<{
				kind: "agent-vault";
				service: string;
				hosts: readonly string[];
		  }>;
}>;

async function fleetAccess(input: {
	readonly credentials: CredentialResolver | undefined;
	readonly agentVault: AgentVaultRouter | undefined;
	readonly transport: HttpTransport;
}): Promise<
	| Readonly<{ ok: true; access: FleetAccess }>
	| Readonly<{ ok: false; result: CommandResult }>
> {
	const token =
		input.credentials === undefined
			? undefined
			: await resolveFleetToken(input.credentials);
	if (token !== undefined)
		return {
			ok: true,
			access: {
				transport: input.transport,
				token,
				source: { kind: "owner-store" },
			},
		};
	if (input.agentVault === undefined)
		return { ok: false, result: credentialUnavailable() };
	const resolution = await input.agentVault(HOSTINGER_API_HOST);
	if (!resolution.ok)
		return {
			ok: false,
			result:
				resolution.refusal.code === "HOBO_AGENT_VAULT_UNAVAILABLE" ||
				resolution.refusal.code === "HOBO_AGENT_VAULT_NO_SERVICE"
					? credentialUnavailable(resolution.refusal)
					: agentVaultRefused(resolution.refusal),
		};
	const { route } = resolution;
	return {
		ok: true,
		access: {
			transport: route.transport,
			token: route.credential ?? "",
			source: {
				kind: "agent-vault",
				service: route.service,
				hosts: route.hosts,
			},
		},
	};
}

function sourceNote(access: FleetAccess): string {
	return access.source.kind === "agent-vault"
		? ` (through Infisical Agent Vault service ${access.source.service}: ${access.source.hosts.join(", ")})`
		: "";
}

async function resolveFleetToken(
	credentials: CredentialResolver,
): Promise<string | undefined> {
	const material = await credentials
		.resolve(CI_FLEET_TOKEN_REF, CREDENTIAL_SCOPE)
		.catch(() => undefined);
	const token = material?.token;
	return token === "" ? undefined : token;
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
	return token === "" ? text : text.split(token).join("[redacted]");
}

export async function runCiFleet(input: {
	readonly positionals: readonly string[];
	readonly credentials: CredentialResolver | undefined;
	readonly agentVault?: AgentVaultRouter | undefined;
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
	const granted = await fleetAccess({
		credentials: input.credentials,
		agentVault: input.agentVault,
		transport: input.transport,
	});
	if (!granted.ok) return granted.result;
	const { access } = granted;
	const { token } = access;
	const credentialSource =
		access.source.kind === "agent-vault"
			? {
					kind: access.source.kind,
					service: access.source.service,
					hosts: [...access.source.hosts],
				}
			: { kind: access.source.kind };
	const fleet = hostingerVpsFleet({
		transport: access.transport,
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
						? `The Hostinger account has no virtual machines${sourceNote(access)}.`
						: [
								`Hostinger fleet${sourceNote(access)}: ${hosts.length} machine${hosts.length === 1 ? "" : "s"}`,
								...hosts.map(hostLine),
							].join("\n"),
				data: {
					fleet: toJson(CiFleetStatusSchema, status, {
						alwaysEmitImplicit: true,
					}),
					credentialSource,
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
			message: `Hostinger accepted ${receipt.action} of machine ${receipt.machine.id} (${receipt.machine.hostname || "no hostname"})${sourceNote(access)}: action ${receipt.actionId} is ${receipt.actionState}. Run hobo ci fleet status to watch it settle.`,
			data: {
				fleetAction: toJson(CiFleetPowerActionSchema, record, {
					alwaysEmitImplicit: true,
				}),
				credentialSource,
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
