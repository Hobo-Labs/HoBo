/**
 * `node --import tsx packages/fleet/examples/demo.ts`
 *
 * Three agents on the in-memory bus (design §11.4 L07; it replaces the old
 * `mesh:demo`): one dispatcher-executor and two executors enroll with
 * bootstrap tokens against the test authority, refresh their credentials,
 * connect, observe themselves and take work. Five units of work are offered;
 * the demo prints one receipt per offer and exits 0 when every offer has
 * exactly one, or 1 after 90 seconds.
 */
import { create, fromBinary } from "@bufbuild/protobuf";
import {
	DeviceClass,
	EnrollmentRequestSchema,
	ReceiptStatus,
	Role,
	WorkReceiptSchema,
} from "../src/_generated/fleet_pb.js";
import { workDigest } from "../src/work/index.js";
import {
	agentIn,
	createWorld,
	FLEET,
	heldRunner,
	KIND,
	queueSource,
	TENANT,
} from "./world.js";

const OFFERS = ["build-1", "build-2", "build-3", "test-1", "test-2"];
const LIMIT_MS = 90_000;
const now = () => Date.now();

const world = await createWorld(now);
const work = queueSource(now);
const names = new Map<string, string>();

const agents = [];
const members: readonly (readonly [string, readonly Role[]])[] = [
	["hub", [Role.DISPATCHER, Role.EXECUTOR]],
	["runner-1", [Role.EXECUTOR]],
	["runner-2", [Role.EXECUTOR]],
];
for (const [name, roles] of members) {
	const { runner } = heldRunner();
	const built = agentIn(world, {
		now,
		runners: [runner],
		sources: roles.includes(Role.DISPATCHER) ? [work.source] : [],
	});
	const enrolled = await built.agent.enroll(
		create(EnrollmentRequestSchema, {
			tenant: TENANT,
			fleet: FLEET,
			name,
			displayName: name,
			platform: { os: process.platform, arch: process.arch },
			deviceClass: DeviceClass.DEDICATED,
			requestedRoles: [...roles],
			proof: { case: "bootstrapToken", value: await world.token(name, roles) },
		}),
	);
	if (!enrolled.ok) throw new Error(`${name}: ${enrolled.error.message}`);
	names.set((await built.keys.open()).memberId, name);
	agents.push(built.agent);
}

const byDigest = new Map<string, string>(
	OFFERS.map((key) => [workDigest(KIND, key), key]),
);
const receipts = new Map<string, string[]>();
let finish: (() => void) | undefined;
const finished = new Promise<void>((resolve) => {
	finish = resolve;
});
world.bus.events.subscribe(["receipt"], "start", async (event) => {
	const receipt = fromBinary(WorkReceiptSchema, event.payload);
	if (receipt.status === ReceiptStatus.STARTED) return;
	const key = byDigest.get(receipt.workDigest) ?? receipt.workDigest;
	const status = ReceiptStatus[receipt.status] ?? String(receipt.status);
	receipts.set(key, [...(receipts.get(key) ?? []), status]);
	console.log(
		`receipt ${key}: ${status} on ${names.get(receipt.memberId) ?? receipt.memberId} (order ${receipt.orderId.slice(0, 8)})`,
	);
	if (OFFERS.every((offer) => receipts.has(offer))) finish?.();
});

for (const agent of agents) await agent.start();
for (const key of OFFERS) work.add(key);

const timeout = setTimeout(() => finish?.(), LIMIT_MS);
await finished;
clearTimeout(timeout);
for (const agent of agents) await agent.stop();

const once = OFFERS.every((offer) => receipts.get(offer)?.length === 1);
console.log(
	once
		? `${OFFERS.length} offers, ${OFFERS.length} receipts: one receipt per offer`
		: `missing or duplicated receipts: ${JSON.stringify(Object.fromEntries(receipts))}`,
);
process.exit(once ? 0 : 1);
