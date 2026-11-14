/**
 * The acceptance flows of O2 (design §10.1), over any bus the world was built
 * on: a device enrolls (bootstrap token, the person's browser approval, or a
 * workload identity), starts as dispatcher and executor of its fleet, and the
 * developer's own `oci-command` job reaches a `SUCCEEDED` receipt. The
 * cucumber steps (`features/steps/fleet/`) and
 * `enroll-and-run.integration.test.ts` both run these.
 */
import { createHash, randomBytes } from "node:crypto";
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	DeviceClass,
	type EgressProxyFactory,
	EnrollmentRequestSchema,
	type EnrollmentResponse,
	type KeyStore,
	type MemberRecord,
	MemberRecordSchema,
	type Outcome,
	type PersonCredential,
	PlatformSchema,
	ReceiptStatus,
	type Role,
	type SandboxDriver,
	type WorkReceipt,
	WorkReceiptSchema,
	type WorkRunner,
	type WorkStatus,
	WorkSubmissionRequestSchema,
} from "@hobo/fleet";
import { jwkThumbprint, mintDpopProof, parsePublicJwk } from "@hobo/fleet/keys";
import {
	createOciCommandRunner,
	createOciCommandSource,
	workDigest,
} from "@hobo/fleet/work";
import {
	type FleetWorld,
	ISSUER,
	liveBus,
	PEOPLE,
	type PersonName,
	TENANT,
} from "./world.js";

export type Proof =
	| Readonly<{ case: "bootstrapToken"; value: string }>
	| Readonly<{ case: "personToken"; value: string }>
	| Readonly<{ case: "oidcAssertion"; value: string }>;

export type Enrolled = Readonly<{
	agent: ReturnType<FleetWorld["agent"]>["agent"];
	keys: KeyStore;
	response: Outcome<EnrollmentResponse>;
	record: MemberRecord | undefined;
}>;

export function decodeMember(
	response: Outcome<EnrollmentResponse>,
): MemberRecord | undefined {
	if (!response.ok || response.value.memberRecord === undefined)
		return undefined;
	return fromBinary(MemberRecordSchema, response.value.memberRecord.payload);
}

/** A device agent that dispatches and executes `oci-command` work, enrolled with `proof`. */
export async function enrollDevice(
	world: FleetWorld,
	input: Readonly<{
		fleet: string;
		name: string;
		roles: readonly Role[];
		proof: (keys: KeyStore) => Promise<Proof>;
		deviceClass?: DeviceClass;
		sandboxes?: readonly SandboxDriver[];
		keys?: KeyStore;
		runners?: readonly WorkRunner[];
		egress?: EgressProxyFactory;
	}>,
): Promise<Enrolled> {
	const built = world.agent({
		keys: input.keys,
		sandboxes: input.sandboxes,
		egress: input.egress,
		runners: input.runners ?? [createOciCommandRunner()],
		sources: (current) => [
			createOciCommandSource(liveBus(() => current()?.bus())),
		],
	});
	const proof = await input.proof(built.keys);
	const response = await built.agent.enroll(
		create(EnrollmentRequestSchema, {
			tenant: TENANT,
			fleet: input.fleet,
			name: input.name,
			displayName: input.name,
			platform: create(PlatformSchema, {
				os: "linux",
				arch: process.arch === "arm64" ? "arm64" : "x64",
			}),
			region: "eu-west-1",
			deviceClass: input.deviceClass ?? DeviceClass.DEDICATED,
			requestedRoles: [...input.roles],
			proof,
		}),
	);
	return { ...built, response, record: decodeMember(response) };
}

/** A sign-in through the authority's routes, with `key` as the DPoP key: browser on a loopback redirect, or the device-code flow. */
export async function signIn(
	world: FleetWorld,
	who: PersonName,
	key: Readonly<{
		signer: Parameters<typeof mintDpopProof>[0];
		publicJwk: Parameters<typeof mintDpopProof>[1];
	}>,
	flow: "browser" | "device-code",
) {
	const send = async (
		method: string,
		path: string,
		body?: string,
		headers: Record<string, string> = {},
	) => {
		const init: RequestInit = {
			method,
			headers: { ...headers },
			redirect: "manual",
		};
		if (body !== undefined) {
			init.body = body;
			init.headers = { "content-type": "application/json", ...headers };
		}
		const response = await world.handler(new Request(`${ISSUER}${path}`, init));
		const text = await response.text();
		return { status: response.status, headers: response.headers, text };
	};
	const dpop = (path: string) =>
		mintDpopProof(key.signer, key.publicJwk, {
			htm: "POST",
			htu: `${ISSUER}${path}`,
			nowMs: world.now(),
		});
	const verifier = randomBytes(32).toString("base64url");
	const started = await send(
		"POST",
		"/v1/fleet/signin/start",
		JSON.stringify({
			provider: "test",
			tenant: TENANT,
			redirectUri: flow === "browser" ? "http://127.0.0.1:5555/callback" : "",
			codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
			dpopThumbprint: jwkThumbprint(key.publicJwk),
			deviceFlow: flow === "device-code",
			hostName: "dev-laptop",
			deviceName: "Developer laptop",
			platform: { os: "linux", arch: "x64" },
		}),
	);
	if (started.status !== 200)
		throw new Error(`signin/start ${started.status}: ${started.text}`);
	const challenge: { state: string; userCode?: string } = JSON.parse(
		started.text,
	);
	const state = challenge.state;
	/** Each poll's answer: "ok", or the FleetError code. */
	const polls: string[] = [];
	const poll = async () => {
		const answer = await send(
			"POST",
			"/v1/fleet/signin/device/poll",
			JSON.stringify({ state }),
			{
				dpop: await dpop("/v1/fleet/signin/device/poll"),
			},
		);
		const body: { code?: string } =
			answer.status === 200 ? {} : JSON.parse(answer.text);
		polls.push(
			answer.status === 200 ? "ok" : (body.code ?? String(answer.status)),
		);
		return answer;
	};
	if (flow === "device-code") await poll();
	if (flow === "device-code") {
		const entered = await send(
			"POST",
			"/v1/fleet/signin/device",
			JSON.stringify({ userCode: challenge.userCode ?? "" }),
		);
		if (entered.status !== 200)
			throw new Error(`signin/device ${entered.status}: ${entered.text}`);
	}
	const called = await send(
		"GET",
		`/v1/fleet/signin/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(`user:${PEOPLE[who].id}`)}`,
	);
	const cookie = (called.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	const page = await send(
		"GET",
		`/v1/fleet/approve/${encodeURIComponent(state)}`,
		undefined,
		{ cookie },
	);
	const decided = await send(
		"POST",
		`/v1/fleet/approve/${encodeURIComponent(state)}`,
		JSON.stringify({ approve: true }),
		{
			cookie,
		},
	);
	if (decided.status !== 200)
		throw new Error(`approve ${decided.status}: ${decided.text}`);
	let credential: { status: number; text: string };
	if (flow === "browser") {
		const redirect: string = JSON.parse(decided.text).redirectUri ?? "";
		const code = new URL(redirect).searchParams.get("code") ?? "";
		credential = await send(
			"POST",
			"/v1/fleet/signin/complete",
			JSON.stringify({ state, code, codeVerifier: verifier }),
			{ dpop: await dpop("/v1/fleet/signin/complete") },
		);
	} else credential = await poll();
	if (credential.status !== 200)
		throw new Error(`credential ${credential.status}: ${credential.text}`);
	const issued: Pick<PersonCredential, "token" | "principal"> = JSON.parse(
		credential.text,
	);
	return {
		token: issued.token,
		principal: issued.principal,
		page: page.text,
		polls,
		poll,
		state,
	};
}

/** The person's browser approval of a device: a sign-in whose DPoP key is the device's identity key. */
export async function browserApproval(
	world: FleetWorld,
	who: PersonName,
	keys: KeyStore,
): Promise<Proof> {
	const device = await keys.open();
	const jwk = parsePublicJwk(device.identityJwk);
	if (!jwk.ok) throw new Error(jwk.error.message);
	const signed = await signIn(
		world,
		who,
		{ signer: device.identity, publicJwk: jwk.value },
		"browser",
	);
	return { case: "personToken", value: signed.token };
}

/** The image the jobs run in: busybox, pinned by digest (the sandbox suite's probe image). */
export const PROBE_IMAGE = {
	image: "docker.io/library/busybox:1.37.0",
	digest:
		"sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec",
} as const;

/** The developer submits an `oci-command` job to the fleet through the authority. */
export async function submitJob(
	world: FleetWorld,
	who: PersonName,
	fleet: string,
	argv: readonly string[],
	image: Readonly<{ image: string; digest: string }> = PROBE_IMAGE,
): Promise<WorkStatus> {
	const { caller } = await world.person(who);
	const submitted = await world.authority.submitWork(
		create(WorkSubmissionRequestSchema, {
			fleet,
			image: image.image,
			imageDigest: image.digest,
			argv: [...argv],
			ttlSeconds: 600,
		}),
		caller,
	);
	if (!submitted.ok)
		throw new Error(
			`submitWork: ${submitted.error.code} ${submitted.error.message}`,
		);
	return submitted.value;
}

/** Every receipt published on the bus, as they arrive. */
export function watchReceipts(world: FleetWorld): WorkReceipt[] {
	const seen: WorkReceipt[] = [];
	world.bus.events.subscribe(["receipt"], "start", async (event) => {
		seen.push(fromBinary(WorkReceiptSchema, event.payload));
	});
	return seen;
}

export async function until(
	check: () => boolean | Promise<boolean>,
	timeoutMs: number,
	what: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

/** The final receipt of a submitted job, once one arrives. */
export async function finalReceipt(
	receipts: readonly WorkReceipt[],
	submission: WorkStatus,
	timeoutMs: number,
): Promise<WorkReceipt> {
	const digest =
		submission.workDigest.length > 0
			? submission.workDigest
			: workDigest("oci-command", submission.submissionId);
	const final = () =>
		receipts.find(
			(receipt) =>
				receipt.workDigest === digest &&
				receipt.status !== ReceiptStatus.STARTED,
		);
	await until(
		() => final() !== undefined,
		timeoutMs,
		`a final receipt for ${submission.submissionId}`,
	);
	const found = final();
	if (found === undefined) throw new Error("no receipt");
	return found;
}

/** An `oci-command` runner that records the argv it ran and, while held, waits to be released before it succeeds. */
export function heldRunner() {
	const ran: string[] = [];
	let release: (() => void) | undefined;
	let held: Promise<void> | undefined;
	const runner: WorkRunner = {
		kind: "oci-command",
		async run(input) {
			ran.push(input.order.parameters.argv ?? "");
			if (held !== undefined) await held;
			return {
				status: ReceiptStatus.SUCCEEDED,
				reason: "",
				outputDigest: `sha256:${"0".repeat(64)}`,
				observedWorkKey: "",
			};
		},
	};
	return {
		runner,
		ran,
		hold() {
			held = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		release() {
			release?.();
			held = undefined;
		},
	};
}
