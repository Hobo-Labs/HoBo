#!/usr/bin/env node
/**
 * `hobo-fleet-authority --config <file>`: the authority service of §6.15 in
 * either profile of §6.16. Reads the configuration and its secret store,
 * composes the authority, serves HTTP on `listen`, answers NATS auth callouts,
 * and drives its loops until SIGTERM.
 */
import {
	connectAuthorityBus,
	createJournalEventStore,
	startCalloutResponder,
} from "@hobo/fleet-nats";
import {
	createRuntimeLocalEventStore,
	defaultDbPath,
} from "@hobo/runtime-local";
import { composeAuthority } from "../compose/profile.js";
import { createAuthorityHandler } from "../service/http.js";
import { serveAuthority } from "../service/node.js";
import { boot, fail, onShutdown, stderrLog } from "./common.js";

const { config, secrets } = await boot(
	process.argv.slice(2),
	"usage: hobo-fleet-authority --config <file>",
);
const now = () => Date.now();
const composed = await composeAuthority(config, {
	secrets,
	fetch: (input, init) => fetch(input, init),
	now,
	log: stderrLog,
	connectBus: connectAuthorityBus,
	journalStore: createJournalEventStore,
	sqliteStore: (dataDir) =>
		createRuntimeLocalEventStore({
			dataDir,
			dbPath: defaultDbPath(dataDir),
			clock: { now: () => new Date(now()).toISOString() },
		}),
	startCallout: startCalloutResponder,
});
if (!composed.ok) fail(composed.error.message);
const authority = composed.value;
await authority.start();
const handler = createAuthorityHandler({
	runtime: authority.runtime,
	issuer: config.issuer,
	sessionKey: authority.sessionKey,
	credentials: authority.deps.issuer,
	store: authority.deps.store,
	registry: () => authority.deps.bus.registry,
	replay: authority.deps.bus.replay,
	now,
	log: stderrLog,
});
const server = await serveAuthority(handler, {
	origin: config.issuer,
	host: config.listenHost,
	port: config.listenPort,
});
stderrLog("hobo_fleet_bus_status", {
	component: "http",
	status: "listening",
	port: config.listenPort,
	profile: config.profile,
});
onShutdown(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await authority.stop();
});
