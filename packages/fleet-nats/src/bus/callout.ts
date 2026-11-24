import type { Clock, FleetLog, RegistryView, ReplayStore } from "@hobo/fleet";
import type { KeyPair } from "@nats-io/jwt";
import { checkConnect } from "./callout-checks.js";
import {
	mintAuthorizationResponse,
	mintDeviceUser,
	verifyAuthorizationRequest,
} from "./nats-jwt.js";
import type { DeviceTemplate } from "./templates.js";

export type CalloutDeps = Readonly<{
	xkey: KeyPair;
	accountPublicKey: string;
	scopedSeeds: Readonly<Record<DeviceTemplate, string>>;
	registry: RegistryView;
	replay: ReplayStore;
	incarnation: number;
	now: Clock;
	log: FleetLog;
}>;

// public-contract: the `status` of the `hobo_fleet_bus_status` event logged for each allowed callout decision.
export const CALLOUT_AUTHORISED = "authorised";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function answerCallout(
	sealed: Uint8Array,
	serverXkey: string | undefined,
	deps: CalloutDeps,
): Promise<Uint8Array | undefined> {
	if (serverXkey === undefined || serverXkey === "") {
		deps.log("hobo_fleet_callout_refused", {
			check: "request-signature",
			reason: "the request is not sealed to the account's xkey",
		});
		return undefined;
	}
	let opened: Uint8Array | null;
	try {
		opened = deps.xkey.open(sealed, serverXkey);
	} catch {
		opened = null;
	}
	if (opened === null) {
		deps.log("hobo_fleet_callout_refused", {
			check: "request-signature",
			reason: "the request does not open with the account's xkey",
		});
		return undefined;
	}
	const { verified, claims } = verifyAuthorizationRequest(
		decoder.decode(opened),
	);
	const userNkey = claims?.nats.user_nkey;
	const serverId = claims?.nats.server_id?.id;
	if (
		claims === undefined ||
		userNkey === undefined ||
		serverId === undefined
	) {
		deps.log("hobo_fleet_callout_refused", {
			check: "request-signature",
			reason: "the request does not decode",
		});
		return undefined;
	}
	const verdict = await checkConnect({
		requestVerified: verified,
		token: claims.nats.connect_opts?.auth_token,
		serverNonce: claims.nats.client_info?.nonce,
		registry: deps.registry,
		replay: deps.replay,
		incarnation: deps.incarnation,
		now: deps.now,
	});
	const nowMs = deps.now();
	let response: string;
	if (verdict.ok) {
		const signerSeed = deps.scopedSeeds[verdict.template];
		const jwt = await mintDeviceUser({
			userNkey,
			memberId: verdict.memberId,
			accountPublicKey: deps.accountPublicKey,
			scopedSeed: signerSeed,
			nowMs,
		});
		response = await mintAuthorizationResponse({
			userNkey,
			serverId,
			accountPublicKey: deps.accountPublicKey,
			signerSeed,
			answer: { jwt },
			nowMs,
		});
		deps.log("hobo_fleet_bus_status", {
			component: "callout",
			status: CALLOUT_AUTHORISED,
			member: verdict.memberId,
			template: verdict.template,
		});
	} else {
		deps.log("hobo_fleet_callout_refused", {
			check: verdict.check,
			reason: verdict.reason,
		});
		response = await mintAuthorizationResponse({
			userNkey,
			serverId,
			accountPublicKey: deps.accountPublicKey,
			signerSeed: deps.scopedSeeds.observer,
			answer: { error: `refused: ${verdict.check}` },
			nowMs,
		});
	}
	return deps.xkey.seal(encoder.encode(response), serverXkey);
}
