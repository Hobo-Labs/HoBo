/**
 * The authority composed from its deps (L09): `createEnrollmentAuthority` with
 * its real `AuthorityParts` (sign-in, recorder, registry projection, fleet
 * commands in `mode: "authority"`, the audit chain, and the claim rules with
 * the projection's ranking), the status feed, and the loops that drive them.
 *
 * Both profiles compose through here; they differ only in the deps
 * (`profile.ts`). Nothing here decides anything itself.
 */
import type {
	AuthorityDeps,
	EnrollmentAuthority,
	FleetEventStore,
} from "@hobo/fleet";
import { createAuditChain } from "@hobo/fleet/audit";
import {
	createEnrollmentAuthority,
	createFleetCommands,
	createRecorder,
	createRegistryProjection,
	createSignIn,
} from "@hobo/fleet/membership";
import { checkClaim } from "@hobo/fleet/work";
import { createStatusFeed } from "../status/index.js";
import { withProjectionRanking } from "./ranking.js";

/** The projection asks to be ticked about once a second (L31); the status feed once a minute (L27). */
const TICK_MS = 1_000;
const STATUS_TICK_MS = 60_000;

export type SignInPart = ReturnType<typeof createSignIn>;
export type StatusFeed = ReturnType<typeof createStatusFeed>;

export type AuthorityRuntime = Readonly<{
	authority: EnrollmentAuthority;
	/** The sign-in part, for the three routes whose DPoP proof is not in the method signature (D56). */
	signIn: SignInPart;
	status: StatusFeed;
	/** True once the registry projection has published everything journalled when it started. */
	ready(): boolean;
	/** Starts the recorder and the tick loops; resolves once the first catch-up has begun. */
	start(): void;
	/** One round of every loop, for tests and for a caller that drives time itself. */
	tickOnce(): Promise<void>;
	stop(): Promise<void>;
}>;

export type AssembleOptions = Readonly<{
	/** Default: `createStatusFeed` over `deps.store`. */
	status?: StatusFeed;
	/** Default true. Tests drive `tickOnce` themselves. */
	timers?: boolean;
	statusStore?: FleetEventStore;
}>;

export function assembleAuthority(
	deps: AuthorityDeps,
	options: AssembleOptions = {},
): AuthorityRuntime {
	const signIn = createSignIn(deps);
	const recorder = createRecorder(deps);
	const projection = createRegistryProjection({
		...deps,
		reliability: () => recorder.reliability(),
	});
	const status =
		options.status ??
		createStatusFeed({
			store: options.statusStore ?? deps.store,
			now: deps.now,
			log: deps.log,
		});
	const authority = createEnrollmentAuthority(deps, {
		signIn,
		recorder,
		projection,
		fleets: createFleetCommands({ ...deps, mode: "authority" }),
		audit: createAuditChain({
			store: deps.store,
			log: deps.bus.audit,
			signer: deps.recordSigner,
			incarnation: deps.incarnation,
			now: deps.now,
		}),
		checkClaim: withProjectionRanking(checkClaim, () => deps.bus.registry),
	});

	let ready = false;
	let started = false;
	let stopped = false;
	const timers: ReturnType<typeof setInterval>[] = [];
	let ticking: Promise<void> | undefined;

	const catchUp = async (): Promise<void> => {
		try {
			await projection.caughtUp();
			ready = !stopped;
		} catch (error) {
			deps.log("hobo_fleet_bus_status", {
				component: "projection",
				status: "catch-up-failed",
				reason: error instanceof Error ? error.message : "unknown",
			});
		}
	};

	const tickOnce = async (): Promise<void> => {
		// One tick at a time: a slow tick is never overlapped by the next.
		if (ticking !== undefined) return ticking;
		ticking = (async () => {
			try {
				await authority.tick();
			} catch (error) {
				deps.log("hobo_fleet_bus_status", {
					component: "authority",
					status: "tick-failed",
					reason: error instanceof Error ? error.message : "unknown",
				});
			}
			if (!ready) await catchUp();
		})().finally(() => {
			ticking = undefined;
		});
		return ticking;
	};

	return {
		authority,
		signIn,
		status,
		ready: () => ready && !stopped,
		start() {
			if (started) return;
			started = true;
			recorder.start();
			void tickOnce();
			if (options.timers === false) return;
			const loop = setInterval(() => void tickOnce(), TICK_MS);
			const minute = setInterval(() => {
				void status.tick().catch(() => {});
			}, STATUS_TICK_MS);
			loop.unref?.();
			minute.unref?.();
			timers.push(loop, minute);
		},
		tickOnce,
		async stop() {
			stopped = true;
			for (const timer of timers) clearInterval(timer);
			timers.length = 0;
			await ticking;
			await recorder.stop();
		},
	};
}
