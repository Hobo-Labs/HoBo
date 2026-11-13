// A standalone deployment (SQLite journal through @hobo/runtime-local) with
// ACTIVE members, witnessed checkpoints and credentials, and a fresh one to
// restore into, for the backup and restore tests.
import { join } from "node:path";
import type { FleetEventStore } from "@hobo/fleet";
import {
	createRuntimeLocalEventStore,
	defaultDbPath,
} from "@hobo/runtime-local";
import type { ArchiveDeps } from "../../src/ops/archive.js";
import { sqliteArchiver } from "../../src/ops/compose.js";
import { runCeremony } from "../../src/ops/index.js";
import { type Deployment, deployment } from "./harness.js";
import {
	type EnrolledMember,
	enrollActive,
	enrollmentAuthority,
	publishFleet,
} from "./members.js";
import { opsFixture } from "./support.js";

export async function waitFor(
	condition: () => boolean | Promise<boolean>,
	timeoutMs = 10_000,
): Promise<void> {
	const started = Date.now();
	while (!(await condition())) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

export function sqliteStore(dataDir: string, now: () => number) {
	return createRuntimeLocalEventStore({
		dataDir,
		dbPath: defaultDbPath(dataDir),
		clock: { now: () => new Date(now()).toISOString() },
	});
}

export function archiveDeps(
	fixture: Awaited<ReturnType<typeof opsFixture>>,
	dep: Deployment,
	dataDir: string,
	store: () => Promise<FleetEventStore>,
): ArchiveDeps {
	return {
		tenant: dep.tenant,
		profile: "standalone",
		journal: sqliteArchiver(defaultDbPath(dataDir)),
		store,
		bus: dep.bus,
		secrets: fixture.secrets,
		prefix: fixture.prefix,
		witnessTimeoutMs: 10_000,
		now: fixture.clock.now,
		log: fixture.context.log,
	};
}

/** The deployment that is backed up: `count` ACTIVE members, each with a session ticket, and at least one witnessed checkpoint. */
export async function liveDeployment(count = 3) {
	const fixture = await opsFixture({}, Date.now());
	const ran = await runCeremony(fixture.context);
	if (!ran.ok) throw new Error(ran.error.message);
	const now = fixture.clock.now;
	const dataDir = join(fixture.dir, "live");
	const store = sqliteStore(dataDir, now);
	const dep = await deployment({
		secrets: fixture.secrets,
		prefix: fixture.prefix,
		store,
		now,
	});
	await publishFleet(dep, now);
	const composed = enrollmentAuthority(dep, store, now);
	const members: EnrolledMember[] = [];
	for (let i = 0; i < count; i += 1)
		members.push(await enrollActive(dep, composed, now, `device-${i}`));
	// The chain checkpoints at a tick 60 s or more after its first.
	await dep.tickAudit();
	fixture.clock.advance(61_000);
	await dep.tickAudit();
	// The witness learns of a checkpoint from its fleet.AuditCheckpointed entry, made at the next tick.
	await dep.tickAudit();
	await waitFor(() => dep.audit.witnessed.length >= 1).catch(async () => {
		let events = 0;
		for await (const _ of store.readAll()) events += 1;
		throw new Error(
			`no witnessed checkpoint: ${dep.audit.entries.length} entries, ${events} events, ${dep.witnessLog.join("; ")}`,
		);
	});
	return { fixture, now, dataDir, store, dep, members, composed };
}

/** A fresh deployment of the same operator (same secret store) on an empty data directory and an empty bus. */
export async function freshDeployment(
	live: Awaited<ReturnType<typeof liveDeployment>>,
	name = "restored",
) {
	const dataDir = join(live.fixture.dir, name);
	let opened: ReturnType<typeof sqliteStore> | undefined;
	const open = async () => {
		opened ??= sqliteStore(dataDir, live.now);
		return opened;
	};
	// The witness and chain need a store to exist; they read the restored one once it is loaded.
	const lazy: FleetEventStore = {
		append: async (...args) => (await open()).append(...args),
		read: (streamId, fromSeq) => readThrough(open, streamId, fromSeq),
		subscribe: () => ({ unsubscribe() {} }),
		snapshot: async (...args) => (await open()).snapshot(...args),
		readAll: (options) => readAllThrough(open, options),
	};
	const dep = await deployment({
		secrets: live.fixture.secrets,
		prefix: live.fixture.prefix,
		store: lazy,
		now: live.now,
		genesis: false,
		incarnation: 2,
	});
	return {
		dataDir,
		dep,
		store: open,
		deps: archiveDeps(live.fixture, dep, dataDir, open),
		close: () => opened?.close(),
	};
}

async function* readThrough(
	open: () => Promise<FleetEventStore>,
	streamId: string,
	fromSeq?: number,
) {
	yield* (await open()).read(streamId, fromSeq);
}

async function* readAllThrough(
	open: () => Promise<FleetEventStore>,
	options?: Parameters<FleetEventStore["readAll"]>[0],
) {
	yield* (await open()).readAll(options);
}
