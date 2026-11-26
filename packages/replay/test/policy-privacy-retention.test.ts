/**
 * Recording policy, privacy masking, and retention.
 *
 * Session replay records what a user did in a browser. Every failure here is a
 * privacy failure rather than a crash: recording that stays on in production
 * when nobody enabled it, a password that survives masking into a stored blob,
 * or a session that outlives the retention window and is still there when
 * somebody asks whether it was deleted. None of those throw, and none of them
 * are visible from the outside — which is why the assertions state the leak
 * each one prevents.
 */
import { describe, expect, it } from "vitest";

import {
	applyRetention,
	assertNoSensitivePlaintext,
	createMemoryDualFixtures,
	DEFAULT_RETENTION,
	defaultPrivacyPolicy,
	eraseSessionById,
	evaluateRecordingPolicy,
	REPLAY_ENV_KILL,
	shouldMaskNode,
} from "../src/index.js";

describe("evaluateRecordingPolicy — kill switch", () => {
	it("forces recording off for every spelling of the env kill", () => {
		for (const value of ["0", "false", "off"]) {
			const decision = evaluateRecordingPolicy({
				env: { [REPLAY_ENV_KILL]: value },
				flagEnabled: true,
				sampleRate: 1,
			});
			// The kill switch is the last resort an operator has when recording is
			// misbehaving in production. It must beat the flag, the sample rate and
			// everything else — checking it first is the only way that holds.
			expect(decision.enabled, value).toBe(false);
			expect(decision.reason, value).toBe("env-kill");
			expect(decision.sampleRate, value).toBe(0);
		}
	});

	it("ignores an env value that is not one of the three kill spellings", () => {
		// `HOBO_REPLAY=1` is not a kill. Treating any present value as one would
		// make the variable impossible to use for anything else.
		expect(
			evaluateRecordingPolicy({ env: { [REPLAY_ENV_KILL]: "1" } }).enabled,
		).toBe(true);
	});

	it("refuses to record inside an isolated effect", () => {
		const decision = evaluateRecordingPolicy({ effectIsolated: true });
		// An isolated effect is replaying or testing; recording there would
		// capture synthetic activity as if it were a real user session.
		expect(decision.enabled).toBe(false);
		expect(decision.reason).toBe("effect-isolated");
	});

	it("checks the kill switch before effect isolation", () => {
		// Both apply; the kill switch is reported, because that is the one an
		// operator set deliberately.
		expect(
			evaluateRecordingPolicy({
				env: { [REPLAY_ENV_KILL]: "0" },
				effectIsolated: true,
			}).reason,
		).toBe("env-kill");
	});
});

describe("evaluateRecordingPolicy — flags and sampling", () => {
	it("records everywhere when the flag is explicitly on and fully sampled", () => {
		const decision = evaluateRecordingPolicy({
			flagEnabled: true,
			isolationClass: "production",
		});
		// An explicit flag beats the production default: someone turned this on
		// deliberately, which is the whole point of the flag.
		expect(decision.enabled).toBe(true);
		expect(decision.reason).toBe("flag-on");
		expect(decision.sampleRate).toBe(1);
	});

	it("refuses when the flag is explicitly off, even locally", () => {
		const decision = evaluateRecordingPolicy({
			flagEnabled: false,
			isolationClass: "local-dev",
		});
		// `false` is a decision, not an absence of one. Falling through to the
		// local default would make the flag unable to turn recording off.
		expect(decision.enabled).toBe(false);
		expect(decision.reason).toBe("flag-off");
	});

	it("samples a flagged-on session by unit against the rate", () => {
		const under = evaluateRecordingPolicy({
			flagEnabled: true,
			sampleRate: 0.5,
			sampleUnit: 0.4,
		});
		const over = evaluateRecordingPolicy({
			flagEnabled: true,
			sampleRate: 0.5,
			sampleUnit: 0.5,
		});
		expect(under.enabled).toBe(true);
		expect(under.reason).toBe("flag-on");
		// `unit < rate` is exclusive at the boundary, so a unit exactly at the
		// rate is out. Inclusive would make a rate of 0 record one session in
		// every bucket that hashed to exactly zero.
		expect(over.enabled).toBe(false);
		expect(over.reason).toBe("sampled-out");
	});

	it("clamps a nonsensical sample rate rather than trusting it", () => {
		// A rate above 1 or below 0 comes from a misconfigured flag; clamping
		// keeps it interpretable instead of producing a comparison nobody can
		// reason about.
		expect(
			evaluateRecordingPolicy({
				flagEnabled: true,
				sampleRate: 5,
				sampleUnit: 0.9,
			}).sampleRate,
		).toBe(1);
		expect(
			evaluateRecordingPolicy({ flagEnabled: true, sampleRate: -1 }).sampleRate,
		).toBe(0);
		// NaN clamps to zero rather than propagating: a NaN comparison is always
		// false, which would silently disable recording with no reason given.
		expect(
			evaluateRecordingPolicy({ flagEnabled: true, sampleRate: Number.NaN })
				.sampleRate,
		).toBe(0);
	});
});

describe("evaluateRecordingPolicy — environment defaults", () => {
	it("defaults production and staging to off", () => {
		for (const isolationClass of ["production", "staging"]) {
			const decision = evaluateRecordingPolicy({ isolationClass });
			// Off by default is the privacy posture: recording real users must be
			// something somebody turned on, never something that happened because
			// a default leaked into a new environment.
			expect(decision.enabled, isolationClass).toBe(false);
			expect(decision.reason, isolationClass).toBe("production-default-off");
		}
	});

	it("treats NODE_ENV=production as production-like whatever the isolation class says", () => {
		// Two independent signals. A deployment that set only one of them must
		// still get the production default.
		expect(
			evaluateRecordingPolicy({ env: { NODE_ENV: "production" } }).reason,
		).toBe("production-default-off");
	});

	it("reads the isolation class from the environment when not passed", () => {
		expect(
			evaluateRecordingPolicy({ env: { HOBO_ENV: "production" } }).reason,
		).toBe("production-default-off");
	});

	it("samples into production when a rate is supplied without a flag", () => {
		const inSample = evaluateRecordingPolicy({
			isolationClass: "production",
			sampleRate: 0.5,
			sampleUnit: 0.1,
		});
		const out = evaluateRecordingPolicy({
			isolationClass: "production",
			sampleRate: 0.5,
			sampleUnit: 0.9,
		});
		// A rate is an opt-in of its own — but it reports `sampled-in`, not
		// `flag-on`, so an audit can tell the two apart.
		expect(inSample.enabled).toBe(true);
		expect(inSample.reason).toBe("sampled-in");
		expect(out.enabled).toBe(false);
		expect(out.reason).toBe("sampled-out");
	});

	it("records by default in local and Station environments", () => {
		for (const isolationClass of [undefined, "local-dev", "station"]) {
			const decision = evaluateRecordingPolicy(
				isolationClass === undefined ? {} : { isolationClass },
			);
			// Local is on by default because there is no real user to protect and
			// the whole value of replay is being there when a bug happens.
			expect(decision.enabled, String(isolationClass)).toBe(true);
			expect(decision.reason, String(isolationClass)).toBe("local-default-on");
			expect(decision.sampleRate, String(isolationClass)).toBe(1);
		}
	});

	it("carries the privacy policy through every decision", () => {
		// Even a decision to *not* record carries the policy, so a caller that
		// re-evaluates later cannot end up recording under no policy at all.
		for (const input of [
			{ env: { [REPLAY_ENV_KILL]: "0" } },
			{ effectIsolated: true },
			{ flagEnabled: false },
			{ isolationClass: "production" },
			{},
		]) {
			expect(evaluateRecordingPolicy(input).privacy).toBeDefined();
		}
	});

	it("honours an explicit privacy policy", () => {
		const privacy = { ...defaultPrivacyPolicy(), maskEmails: false };
		expect(evaluateRecordingPolicy({ privacy }).privacy.maskEmails).toBe(false);
	});

	it("returns a frozen decision", () => {
		expect(Object.isFrozen(evaluateRecordingPolicy({}))).toBe(true);
	});
});

describe("shouldMaskNode", () => {
	it("masks the three sensitive input types by default", () => {
		for (const type of ["password", "email", "tel"]) {
			// These are the values that must never reach a stored blob; the
			// default policy has to catch them without any configuration.
			expect(shouldMaskNode({ tag: "input", type }), type).toBe(true);
		}
	});

	it("reads the type from attributes when it is not a direct field", () => {
		// rrweb serializes a DOM node's type into `attributes`, so reading only
		// the direct field would miss every real node.
		expect(
			shouldMaskNode({ tag: "input", attributes: { type: "password" } }),
		).toBe(true);
	});

	it("matches the type case-insensitively", () => {
		expect(shouldMaskNode({ tag: "input", type: "PASSWORD" })).toBe(true);
	});

	it("masks every input and textarea under the default policy", () => {
		// The default is mask-everything-typed, not mask-the-known-bad-types: a
		// text input can hold anything, and enumerating sensitive field names is
		// a losing game.
		expect(shouldMaskNode({ tag: "input", type: "text" })).toBe(true);
		expect(shouldMaskNode({ tag: "textarea" })).toBe(true);
	});

	it("leaves a non-input node alone under the default policy", () => {
		expect(shouldMaskNode({ tag: "div", text: "hello" })).toBe(false);
	});

	it("honours a policy that turns the blanket input mask off", () => {
		const policy = { ...defaultPrivacyPolicy(), maskInputs: false };
		// A plain text input is no longer masked once the blanket switch is off,
		// which is the point of having the switch.
		expect(shouldMaskNode({ tag: "input", type: "text" }, policy)).toBe(false);
		// The three sensitive types stay masked, because their own switches are
		// still on.
		for (const type of ["password", "email", "tel"]) {
			expect(shouldMaskNode({ tag: "input", type }, policy), type).toBe(true);
		}
	});

	it("keeps a sensitive type masked by the default selectors even with its own switch off", () => {
		// Defence in depth, and worth pinning because it surprised me: turning
		// `maskEmails` off does *not* unmask an email input, because the default
		// `maskSelectors` list carries an `input[type=...]` entry and the
		// selector branch re-checks the sensitive-type set independently.
		//
		// That is the safer direction — a single flag flipped by mistake cannot
		// expose a password or an email address — but it means the per-type
		// switches are not sufficient on their own to turn masking off. Anyone
		// who genuinely needs an unmasked email field has to clear the selectors
		// too.
		const policy = {
			...defaultPrivacyPolicy(),
			maskInputs: false,
			maskEmails: false,
			maskPasswords: false,
		};
		expect(shouldMaskNode({ tag: "input", type: "email" }, policy)).toBe(true);
		expect(shouldMaskNode({ tag: "input", type: "password" }, policy)).toBe(
			true,
		);
		// Clearing the selectors as well is what actually unmasks it.
		expect(
			shouldMaskNode(
				{ tag: "input", type: "email" },
				{ ...policy, maskSelectors: [] },
			),
		).toBe(false);
	});

	it("masks a node carrying an attribute-presence selector", () => {
		const policy = {
			...defaultPrivacyPolicy(),
			maskInputs: false,
			maskSelectors: ["[data-hobo-mask]"],
		};
		// The escape hatch for an application that knows a particular node is
		// sensitive; without it, masking would be limited to what the library
		// can infer.
		expect(
			shouldMaskNode(
				{ tag: "div", attributes: { "data-hobo-mask": "" } },
				policy,
			),
		).toBe(true);
		expect(shouldMaskNode({ tag: "div", attributes: {} }, policy)).toBe(false);
	});

	it("masks a node whose selector hints match a class selector", () => {
		const policy = {
			...defaultPrivacyPolicy(),
			maskInputs: false,
			maskSelectors: [".sensitive"],
		};
		expect(
			shouldMaskNode(
				{ tag: "div", selectorHints: ["app sensitive row"] },
				policy,
			),
		).toBe(true);
		expect(shouldMaskNode({ tag: "div", selectorHints: ["row"] }, policy)).toBe(
			false,
		);
	});

	it("masks a sensitive input type named through an input[type=] selector", () => {
		const policy = {
			...defaultPrivacyPolicy(),
			maskInputs: false,
			maskPasswords: false,
			maskSelectors: ["input[type=password]"],
		};
		expect(shouldMaskNode({ tag: "input", type: "password" }, policy)).toBe(
			true,
		);
		expect(shouldMaskNode({ tag: "input", type: "text" }, policy)).toBe(false);
	});

	it("handles a node with no type and no attributes at all", () => {
		// rrweb emits plenty of nodes like this; a lookup that assumed the
		// fields were present would throw mid-recording.
		expect(() => shouldMaskNode({})).not.toThrow();
		expect(shouldMaskNode({})).toBe(false);
	});
});

describe("assertNoSensitivePlaintext", () => {
	it("passes a blob with nothing sensitive in it", () => {
		expect(() => assertNoSensitivePlaintext('{"masked":"••••"}')).not.toThrow();
	});

	it("refuses each default canary and reports only a hint of it", () => {
		for (const secret of [
			"hunter2",
			"user@example.com",
			"+15551212",
			"4111111111111111",
		]) {
			try {
				assertNoSensitivePlaintext(`{"value":"${secret}"}`);
				expect.unreachable(`${secret} must be caught`);
			} catch (error) {
				expect((error as { code?: string }).code).toBe("replay-privacy-leak");
				// The hint is three characters. An error that echoed the whole
				// secret would leak it into the logs the assertion exists to keep
				// it out of.
				const hint = (error as { secretHint?: string }).secretHint ?? "";
				expect(hint).toBe(`${secret.slice(0, 3)}…`);
				expect(hint).not.toContain(secret);
			}
		}
	});

	it("accepts a caller-supplied forbidden list", () => {
		expect(() =>
			assertNoSensitivePlaintext('{"v":"my-own-secret"}', ["my-own-secret"]),
		).toThrowError(/privacy regression/u);
		// And an empty list disables the check rather than defaulting back to the
		// canaries, so a caller can scope it deliberately.
		expect(() =>
			assertNoSensitivePlaintext('{"v":"hunter2"}', []),
		).not.toThrow();
	});
});

describe("applyRetention", () => {
	const STATION = "station:local";

	async function seed(sessions: Array<Record<string, unknown>>) {
		const store = createMemoryDualFixtures();
		for (const session of sessions) {
			await store.index.upsert(session as never);
		}
		return store;
	}

	function session(overrides: Record<string, unknown> = {}) {
		return {
			id: "s1",
			status: "ended",
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:10:00.000Z",
			correlation: { stationId: STATION, isolationClass: "local-dev" },
			...overrides,
		};
	}

	it("erases a session past the retention window and emits an event", async () => {
		const store = await seed([session()]);
		const result = await applyRetention({
			index: store.index,
			stationId: STATION,
			now: new Date("2026-06-01T00:00:00.000Z"),
		});
		// A session that outlived its window and is still there is the failure a
		// data-deletion request would expose; the event is what proves it was
		// removed on schedule rather than on request.
		expect(result.erased).toBe(1);
		expect(result.retained).toBe(0);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.data).toMatchObject({ action: "gc" });
	});

	it("retains a session inside the window", async () => {
		const store = await seed([session()]);
		const result = await applyRetention({
			index: store.index,
			stationId: STATION,
			now: new Date("2026-01-02T00:00:00.000Z"),
		});
		expect(result.erased).toBe(0);
		expect(result.retained).toBe(1);
		expect(result.events).toEqual([]);
	});

	it("counts an already-erased session as retained rather than erasing it twice", async () => {
		const store = await seed([session({ status: "erased" })]);
		const result = await applyRetention({
			index: store.index,
			stationId: STATION,
			now: new Date("2027-01-01T00:00:00.000Z"),
		});
		// Idempotent: a second retention pass over an erased session must not
		// emit a second deletion event, which would double-count in any report.
		expect(result.erased).toBe(0);
		expect(result.retained).toBe(1);
	});

	it("doubles the window for a protected isolation class", async () => {
		const policy = {
			...DEFAULT_RETENTION,
			maxAgeDays: 30,
			retainIsolationClasses: ["production"],
		};
		const store = await seed([
			session({ id: "ordinary" }),
			session({
				id: "production",
				correlation: { stationId: STATION, isolationClass: "production" },
			}),
		]);
		const result = await applyRetention({
			index: store.index,
			stationId: STATION,
			policy,
			// 45 days: past the ordinary window, inside the doubled one.
			now: new Date("2026-02-15T00:00:00.000Z"),
		});
		// A production session is the one most likely to be evidence in an
		// incident; deleting it on the ordinary schedule would destroy the record
		// of the thing being investigated. The protected list is how an operator
		// says "keep these longer" without widening the window for everything.
		expect(result.erased).toBe(1);
		expect(result.retained).toBe(1);
	});

	it("falls back to startedAt when a session never ended", async () => {
		const store = await seed([session({ endedAt: undefined })]);
		const result = await applyRetention({
			index: store.index,
			stationId: STATION,
			now: new Date("2026-06-01T00:00:00.000Z"),
		});
		// A session that never recorded an end is the crashed-tab case. Treating
		// its age as unknown would keep it forever.
		expect(result.erased).toBe(1);
	});

	it("calls the blob eraser for each erased session", async () => {
		const erased: string[] = [];
		const store = await seed([session()]);
		await applyRetention({
			index: store.index,
			stationId: STATION,
			now: new Date("2026-06-01T00:00:00.000Z"),
			eraseBlob: async (sessionId) => {
				erased.push(sessionId);
			},
		});
		// The index row and the blob are two stores. Marking the row erased
		// without removing the blob leaves the recording itself on disk.
		expect(erased).toEqual(["s1"]);
	});

	it("scans nothing for a station with no sessions", async () => {
		const store = await seed([]);
		const result = await applyRetention({
			index: store.index,
			stationId: STATION,
		});
		expect(result).toMatchObject({ scanned: 0, erased: 0, retained: 0 });
	});
});

describe("eraseSessionById", () => {
	const STATION = "station:local";

	async function seeded() {
		const store = createMemoryDualFixtures();
		await store.index.upsert({
			id: "s1",
			status: "ended",
			startedAt: "2026-01-01T00:00:00.000Z",
			endedAt: "2026-01-01T00:10:00.000Z",
			correlation: { stationId: STATION, isolationClass: "local-dev" },
		} as never);
		return store;
	}

	it("erases a session on request", async () => {
		const store = await seeded();
		const erased = await eraseSessionById({
			index: store.index,
			sessionId: "s1",
			stationId: STATION,
		});
		// This is the data-deletion path; it has to actually change the stored
		// status, not just report success.
		expect(erased?.status).toBe("erased");
		expect((await store.index.get("s1"))?.status).toBe("erased");
	});

	it("returns undefined for a session that does not exist", async () => {
		const store = await seeded();
		// Undefined rather than a throw: a deletion request for something already
		// gone has succeeded by any reasonable reading.
		expect(
			await eraseSessionById({
				index: store.index,
				sessionId: "ghost",
				stationId: STATION,
			}),
		).toBeUndefined();
	});

	it("refuses to erase a session belonging to another station", async () => {
		const store = await seeded();
		// Station is the tenancy boundary. Erasing across it would let one
		// operator destroy another's evidence.
		await expect(
			eraseSessionById({
				index: store.index,
				sessionId: "s1",
				stationId: "station:other",
			}),
		).rejects.toThrowError(/foreign station/u);
		expect((await store.index.get("s1"))?.status).toBe("ended");
	});

	it("erases the blob alongside the index row", async () => {
		const erased: string[] = [];
		const store = await seeded();
		await eraseSessionById({
			index: store.index,
			sessionId: "s1",
			stationId: STATION,
			eraseBlob: async (id) => {
				erased.push(id);
			},
		});
		expect(erased).toEqual(["s1"]);
	});
});
