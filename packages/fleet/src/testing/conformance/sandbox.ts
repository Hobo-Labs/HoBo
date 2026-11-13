/**
 * `runSandboxConformance` (design §7.3, §6.11): the logic of the
 * `SandboxDriver` contract, which the fake driver passes. It proves nothing
 * about isolation; `runSandboxIsolationProbe` does that, in real sandboxes.
 *
 * - The driver's self-test answers; each sandbox carries the driver's tier, its
 *   own id and its own `controlUrl`.
 * - A sandbox is single use: one `create` per order id, nothing runs after
 *   `destroy`, and `destroy` is idempotent.
 * - A secret written with `writeSecret` never reaches argv or the environment.
 * - `POST <controlUrl>/fence` with an `ObservedAssignment` answers
 *   `{"allow":true|false}` from the `fence` callback given to `create`.
 * - An exec whose signal is already aborted does not report success.
 */
import { randomBytes } from "node:crypto";
import { WorkOrigin } from "../../_generated/fleet_pb.js";
import type {
	ObservedAssignment,
	Sandbox,
	SandboxDriver,
} from "../../ports.js";
import { type ConformanceAssertion, ensure, fails } from "./assertion.js";

export type SandboxMake = () => SandboxDriver;

type CreateInput = Parameters<SandboxDriver["create"]>[0];

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** The image and limits the logic suite asks for; a real driver may pull the image. */
// public-contract: the image a driver under runSandboxConformance is asked to create sandboxes from.
export const LOGIC_IMAGE = "docker.io/library/busybox:1.37";

const OBSERVED: ObservedAssignment = {
	workKey: "conformance/work#1",
	repository: "hobo/conformance",
	ref: "refs/heads/main",
	author: "conformance",
	origin: WorkOrigin.INTERNAL,
};

export const createInput = (
	orderId: string,
	fence: (observed: ObservedAssignment) => Promise<boolean>,
): CreateInput => ({
	orderId,
	image: LOGIC_IMAGE,
	limits: { memoryMb: 256, cpus: 1, pids: 64, diskMb: 256 },
	egressProxyUrl: "http://127.0.0.1:9",
	readOnlyMounts: [],
	hostDocker: false,
	fence,
});

const orderId = () => `conformance-${randomBytes(8).toString("hex")}`;
const allowAll = async () => true;

/** Runs `argv` in `sandbox` and answers its exit code and everything it wrote. */
export async function run(
	sandbox: Sandbox,
	argv: readonly string[],
	options: Readonly<{
		stdin?: Uint8Array;
		env?: Readonly<Record<string, string>>;
		signal?: AbortSignal;
	}> = {},
): Promise<Readonly<{ exitCode: number; output: string }>> {
	const chunks: Uint8Array[] = [];
	const command = {
		argv,
		env: options.env ?? {},
		signal: options.signal ?? new AbortController().signal,
		onOutput(chunk: Uint8Array) {
			chunks.push(chunk.slice());
		},
	};
	const { exitCode } = await sandbox.exec(
		options.stdin === undefined
			? command
			: { ...command, stdin: options.stdin },
	);
	return {
		exitCode,
		output: chunks.map((chunk) => decoder.decode(chunk)).join(""),
	};
}

/** `POST <controlUrl>/fence` from inside a sandbox, with busybox `wget`. */
export const fenceArgv = (controlUrl: string): readonly string[] => [
	"wget",
	"-q",
	"-T",
	"5",
	"-O-",
	"--header=Content-Type: application/json",
	"--post-file=/dev/stdin",
	`${controlUrl}/fence`,
];

const parseAllow = (output: string): boolean | undefined => {
	try {
		const answer: Readonly<{ allow?: boolean }> = JSON.parse(output.trim());
		return answer.allow === true
			? true
			: answer.allow === false
				? false
				: undefined;
	} catch {
		return undefined;
	}
};

async function withSandbox(
	driver: SandboxDriver,
	fence: (observed: ObservedAssignment) => Promise<boolean>,
	use: (sandbox: Sandbox) => Promise<void>,
): Promise<void> {
	const sandbox = await driver.create(createInput(orderId(), fence));
	try {
		await use(sandbox);
	} finally {
		await sandbox.destroy();
	}
}

/** The sandbox logic assertions, in the order they are registered. */
export const SANDBOX_ASSERTIONS: readonly ConformanceAssertion<SandboxMake>[] =
	[
		{
			name: "the self-test answers ok",
			async check(make) {
				const answer = await make().available();
				ensure(
					answer.ok,
					`available answered ${answer.ok ? "ok" : answer.error.message}`,
				);
			},
		},
		{
			name: "each sandbox carries the driver's tier, its own id and its own controlUrl",
			async check(make) {
				const driver = make();
				const first = await driver.create(createInput(orderId(), allowAll));
				const second = await driver.create(createInput(orderId(), allowAll));
				try {
					ensure(
						first.tier === driver.tier && second.tier === driver.tier,
						`a sandbox of tier ${first.tier} from a driver of tier ${driver.tier}`,
					);
					ensure(
						first.id.length > 0 && first.id !== second.id,
						"two sandboxes share an id",
					);
					ensure(
						first.controlUrl.length > 0 &&
							first.controlUrl !== second.controlUrl,
						"two sandboxes share a controlUrl",
					);
				} finally {
					await first.destroy();
					await second.destroy();
				}
			},
		},
		{
			name: "a second create for one order is refused",
			async check(make) {
				const driver = make();
				const id = orderId();
				const first = await driver.create(createInput(id, allowAll));
				let second: Sandbox | undefined;
				const refused = await fails(async () => {
					second = await driver.create(createInput(id, allowAll));
				});
				await first.destroy();
				await second?.destroy();
				ensure(refused, "a second sandbox was created for one order");
			},
		},
		{
			name: "nothing runs after destroy",
			async check(make) {
				const driver = make();
				const sandbox = await driver.create(createInput(orderId(), allowAll));
				await sandbox.destroy();
				const refused = await fails(async () => {
					await run(sandbox, ["true"]);
				});
				ensure(refused, "a destroyed sandbox ran a command");
			},
		},
		{
			name: "destroy is idempotent",
			async check(make) {
				const sandbox = await make().create(createInput(orderId(), allowAll));
				await sandbox.destroy();
				const failed = await fails(() => sandbox.destroy());
				ensure(!failed, "a second destroy failed");
			},
		},
		{
			name: "a secret written with writeSecret never reaches argv or the environment",
			async check(make) {
				await withSandbox(make(), allowAll, async (sandbox) => {
					const marker = `hobo-secret-${randomBytes(12).toString("hex")}`;
					await sandbox.writeSecret("/run/hobo/secret", encoder.encode(marker));
					const env = await run(sandbox, ["env"]);
					const argv = await run(sandbox, [
						"sh",
						"-c",
						"cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\000' ' '",
					]);
					ensure(
						!env.output.includes(marker),
						"the secret appears in the sandbox environment",
					);
					ensure(
						!argv.output.includes(marker),
						"the secret appears in a process's argv",
					);
				});
			},
		},
		{
			name: "POST <controlUrl>/fence answers from the fence callback",
			async check(make) {
				const driver = make();
				const asked: ObservedAssignment[] = [];
				await withSandbox(
					driver,
					async (observed) => {
						asked.push(observed);
						return observed.workKey === OBSERVED.workKey;
					},
					async (sandbox) => {
						const allowed = await run(sandbox, fenceArgv(sandbox.controlUrl), {
							stdin: encoder.encode(JSON.stringify(OBSERVED)),
						});
						ensure(
							parseAllow(allowed.output) === true,
							`the fence answered ${allowed.output} for matching facts`,
						);
						ensure(
							asked.length === 1 &&
								JSON.stringify(asked[0]) === JSON.stringify(OBSERVED),
							"the fence callback did not receive the observed facts",
						);
						const refused = await run(sandbox, fenceArgv(sandbox.controlUrl), {
							stdin: encoder.encode(
								JSON.stringify({ ...OBSERVED, workKey: "other/work#2" }),
							),
						});
						ensure(
							parseAllow(refused.output) === false,
							`the fence answered ${refused.output} for other facts`,
						);
					},
				);
			},
		},
		{
			name: "an exec whose signal is already aborted does not report success",
			async check(make) {
				await withSandbox(make(), allowAll, async (sandbox) => {
					const controller = new AbortController();
					controller.abort();
					let exitCode = 0;
					const threw = await fails(async () => {
						exitCode = (
							await run(sandbox, ["true"], { signal: controller.signal })
						).exitCode;
					});
					ensure(threw || exitCode !== 0, "an aborted exec reported success");
				});
			},
		},
	];
