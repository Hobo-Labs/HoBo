/**
 * The `HOBO_HOME/profile.json` document — parse, merge, persist.
 *
 * The profile is the only piece of durable state a user carries between
 * invocations: which Station they occupy, which broker they deploy to, and
 * whether they are logged in. Three properties matter.
 *
 * **A malformed profile reads as absent, not as a crash.** `loadHoboProfile`
 * swallows both unreadable JSON and a document that fails the parser, because
 * a corrupt profile must not make every command in the CLI unusable — the
 * commands that need one already know how to ask the user to log in or
 * initialize a Station.
 *
 * **The parser refuses partial identity outright.** A session missing its
 * tenant, token, or issue time is not a session that "mostly works": it would
 * be presented as a credential and rejected by a broker with an error naming
 * neither the profile nor the field. `parseHoboProfile` throws where the fault
 * is visible.
 *
 * **Upserts preserve what they were not asked to change.** `hobo login` must
 * not silently drop a default Station, and `hobo station init` must not log the
 * user out. Each writer rebuilds the whole document, so every field it does
 * not own has to be carried forward explicitly — and each of those carries is
 * a branch that, if wrong, loses user state without any error at all.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	HOBO_PROFILE_SCHEMA,
	type HoboProfile,
	loadHoboProfile,
	parseHoboProfile,
	profilePath,
	saveHoboProfile,
	setDefaultStation,
	upsertLoginProfile,
} from "../src/hobo-profile.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function home(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-profile-"));
	dirs.push(dir);
	return dir;
}

/** A minimal document that parses, for tests that vary one field at a time. */
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: HOBO_PROFILE_SCHEMA,
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

const SESSION = {
	principal: { kind: "user", id: "user:ada" },
	tenant: "acme",
	token: "tok",
	issuedAt: "2026-01-01T00:00:00.000Z",
};

describe("parseHoboProfile — shape", () => {
	it("refuses anything that is not an object", () => {
		// A JSON file holding `null`, a bare string, or an array is not a profile
		// with missing fields — it is a different document entirely, and reading
		// fields off it would produce a profile of all-undefined rather than an
		// error naming the file.
		for (const raw of [null, "profile", 7, true, undefined]) {
			expect(() => parseHoboProfile(raw)).toThrow(TypeError);
		}
	});

	it("refuses a document whose schemaVersion is not the one it knows", () => {
		// The version is the contract. Reading a future document with today's
		// parser would silently discard fields this version does not know about
		// and then write them away on the next save.
		for (const version of [undefined, "hobo.profile/v2", "", 1]) {
			expect(() => parseHoboProfile(doc({ schemaVersion: version }))).toThrow(
				/schemaVersion/,
			);
		}
	});

	it("refuses a missing or empty updatedAt", () => {
		// `updatedAt` is how a reader decides which of two profiles is current.
		// An empty string sorts before every real timestamp, so it would make a
		// fresh profile look like the oldest one on the machine.
		for (const updatedAt of [undefined, "", 0, null]) {
			expect(() => parseHoboProfile(doc({ updatedAt }))).toThrow(/updatedAt/);
		}
	});

	it("keeps a bare profile with neither station nor session", () => {
		// Both are optional: a user who has run nothing but `hobo login --broker`
		// has a broker and no Station, and that is a valid state, not a partial
		// write to be rejected.
		const profile = parseHoboProfile(doc());
		expect(profile.schemaVersion).toBe(HOBO_PROFILE_SCHEMA);
		expect(profile.defaultStation).toBeUndefined();
		expect(profile.session).toBeUndefined();
	});
});

describe("parseHoboProfile — optional scalars", () => {
	it("keeps a non-empty broker uri and drops an empty one", () => {
		// An empty `defaultBrokerUri` would be treated as "a broker is
		// configured" by every caller that checks for presence, and then fail at
		// request time against the empty string.
		expect(
			parseHoboProfile(doc({ defaultBrokerUri: "https://b.example" }))
				.defaultBrokerUri,
		).toBe("https://b.example");
		for (const value of ["", 7, null, undefined]) {
			expect(
				parseHoboProfile(doc({ defaultBrokerUri: value })).defaultBrokerUri,
			).toBeUndefined();
		}
	});

	it("keeps a non-empty active rail and drops an empty one", () => {
		expect(parseHoboProfile(doc({ activeRail: "main" })).activeRail).toBe(
			"main",
		);
		for (const value of ["", 0, null, undefined]) {
			expect(
				parseHoboProfile(doc({ activeRail: value })).activeRail,
			).toBeUndefined();
		}
	});
});

describe("parseHoboProfile — default station", () => {
	it("requires an id when a station is present at all", () => {
		// A station entry with no id is worse than none: callers that check for
		// the object's presence would proceed and then place work against an
		// undefined station.
		for (const ds of [{}, { id: "" }, { id: 7 }, { dataDir: "/tmp/x" }]) {
			expect(() => parseHoboProfile(doc({ defaultStation: ds }))).toThrow(
				/defaultStation\.id/,
			);
		}
	});

	it("treats an absent or null station as simply not set", () => {
		// `null` is what a hand-edited profile most often contains after someone
		// removes their station. Throwing there would lock a user out of every
		// command over an edit that clearly meant "none".
		for (const ds of [undefined, null]) {
			expect(
				parseHoboProfile(doc({ defaultStation: ds })).defaultStation,
			).toBeUndefined();
		}
	});

	it("keeps dataDir when it is a string and omits it otherwise", () => {
		expect(
			parseHoboProfile(doc({ defaultStation: { id: "s1", dataDir: "/data" } }))
				.defaultStation?.dataDir,
		).toBe("/data");
		expect(
			parseHoboProfile(doc({ defaultStation: { id: "s1", dataDir: 7 } }))
				.defaultStation?.dataDir,
		).toBeUndefined();
	});

	it("freezes the station so a caller cannot mutate parsed state", () => {
		// The parsed profile is handed to command code that has no reason to
		// write to it. Freezing turns an accidental mutation into a visible
		// failure instead of state that disagrees with the file on disk.
		const station = parseHoboProfile(doc({ defaultStation: { id: "s1" } }))
			.defaultStation as { id: string };
		expect(Object.isFrozen(station)).toBe(true);
	});
});

describe("parseHoboProfile — session", () => {
	it("requires tenant, token, and issuedAt, each by name", () => {
		// Which field is missing decides the fix — a missing token means log in
		// again, a missing tenant means the profile was written by an older
		// build. One generic "invalid session" would not separate them.
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ tenant: "" }, /tenant/],
			[{ tenant: undefined }, /tenant/],
			[{ token: "" }, /token/],
			[{ token: 7 }, /token/],
			[{ issuedAt: "" }, /issuedAt/],
			[{ issuedAt: null }, /issuedAt/],
		];
		for (const [override, expected] of cases) {
			expect(() =>
				parseHoboProfile(doc({ session: { ...SESSION, ...override } })),
			).toThrow(expected);
		}
	});

	it("keeps proofKeyId and brokerUri only when they are strings", () => {
		// `proofKeyId` names key material held elsewhere; a number there would be
		// looked up and missed, presenting a credential with no proof rather than
		// refusing to present one.
		const full = parseHoboProfile(
			doc({
				session: { ...SESSION, proofKeyId: "k1", brokerUri: "https://b" },
			}),
		);
		expect(full.session?.proofKeyId).toBe("k1");
		expect(full.session?.brokerUri).toBe("https://b");

		const partial = parseHoboProfile(
			doc({ session: { ...SESSION, proofKeyId: 7, brokerUri: null } }),
		);
		expect(partial.session?.proofKeyId).toBeUndefined();
		expect(partial.session?.brokerUri).toBeUndefined();
	});

	it("treats an absent or null session as logged out", () => {
		for (const session of [undefined, null]) {
			expect(parseHoboProfile(doc({ session })).session).toBeUndefined();
		}
	});

	it("carries the other optional fields through alongside a session", () => {
		// The session branch returns a fresh object rather than mutating, so
		// every field established before it has to be spread back in. Losing the
		// broker on login is exactly the bug that shape invites.
		const profile = parseHoboProfile(
			doc({
				defaultBrokerUri: "https://b.example",
				activeRail: "main",
				defaultStation: { id: "s1" },
				session: SESSION,
			}),
		);
		expect(profile.defaultBrokerUri).toBe("https://b.example");
		expect(profile.activeRail).toBe("main");
		expect(profile.defaultStation?.id).toBe("s1");
		expect(profile.session?.principal.id).toBe("user:ada");
	});
});

describe("parseHoboProfile — principal", () => {
	it("refuses a principal that is not an object", () => {
		for (const principal of [null, "user:ada", 7, undefined]) {
			expect(() =>
				parseHoboProfile(doc({ session: { ...SESSION, principal } })),
			).toThrow(/principal/);
		}
	});

	it("accepts exactly the four known kinds", () => {
		// The kind decides how a principal is authorized. An unrecognised one
		// reaching policy would be compared against rules written for the four,
		// matching none and failing somewhere far from the profile.
		for (const kind of ["user", "agent", "service", "system"]) {
			const profile = parseHoboProfile(
				doc({ session: { ...SESSION, principal: { kind, id: "p" } } }),
			);
			expect(profile.session?.principal.kind).toBe(kind);
		}
		for (const kind of ["admin", "", 7, undefined]) {
			expect(() =>
				parseHoboProfile(
					doc({ session: { ...SESSION, principal: { kind, id: "p" } } }),
				),
			).toThrow(/principal\.kind/);
		}
	});

	it("requires a non-empty principal id", () => {
		for (const id of ["", undefined, 7, null]) {
			expect(() =>
				parseHoboProfile(
					doc({ session: { ...SESSION, principal: { kind: "user", id } } }),
				),
			).toThrow(/principal\.id/);
		}
	});

	it("parses a delegation chain recursively, refusing a bad link", () => {
		// Delegation is the audit trail: an agent acting for a human acting for
		// an org. A malformed link accepted here would present as a shorter chain
		// than actually happened.
		const profile = parseHoboProfile(
			doc({
				session: {
					...SESSION,
					principal: {
						kind: "agent",
						id: "agent:bot",
						delegatedBy: { kind: "user", id: "user:ada" },
					},
				},
			}),
		);
		expect(profile.session?.principal.delegatedBy?.id).toBe("user:ada");

		expect(() =>
			parseHoboProfile(
				doc({
					session: {
						...SESSION,
						principal: {
							kind: "agent",
							id: "agent:bot",
							delegatedBy: { kind: "user", id: "" },
						},
					},
				}),
			),
		).toThrow(/principal\.id/);
	});
});

describe("load and save", () => {
	it("reports no profile rather than throwing when the file is absent", () => {
		// Every command reads the profile; a first run has none. Throwing here
		// would make "you have not logged in yet" indistinguishable from a bug.
		expect(loadHoboProfile(home())).toBeNull();
	});

	it("reports no profile for unreadable JSON", () => {
		// A truncated write — an interrupted `hobo login` — leaves exactly this.
		// The recovery is to log in again, which the caller can offer only if it
		// is told "no profile" rather than handed a parse error.
		const dir = home();
		writeFileSync(profilePath(dir), "{ not json", "utf8");
		expect(loadHoboProfile(dir)).toBeNull();
	});

	it("reports no profile for JSON that fails the parser", () => {
		const dir = home();
		writeFileSync(profilePath(dir), JSON.stringify({ hello: 1 }), "utf8");
		expect(loadHoboProfile(dir)).toBeNull();
	});

	it("round-trips a saved profile and creates the home directory", () => {
		// `saveHoboProfile` is called before anything else has necessarily made
		// HOBO_HOME. Requiring the directory to exist would make login fail on
		// exactly the machines where it is being run for the first time.
		const dir = join(home(), "nested", "home");
		const profile: HoboProfile = {
			schemaVersion: HOBO_PROFILE_SCHEMA,
			updatedAt: "2026-01-01T00:00:00.000Z",
			defaultBrokerUri: "https://b.example",
		};
		const written = saveHoboProfile(dir, profile);
		expect(written).toBe(profilePath(dir));
		expect(loadHoboProfile(dir)?.defaultBrokerUri).toBe("https://b.example");
	});

	it("writes the document with a trailing newline", () => {
		// The profile is hand-edited often enough that it should behave like a
		// text file under every editor and diff tool that expects one.
		const dir = home();
		saveHoboProfile(dir, {
			schemaVersion: HOBO_PROFILE_SCHEMA,
			updatedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(readFileSync(profilePath(dir), "utf8").endsWith("}\n")).toBe(true);
	});
});

describe("upsertLoginProfile", () => {
	it("writes a session from nothing on a first login", () => {
		const dir = home();
		const profile = upsertLoginProfile({
			hoboHome: dir,
			principal: { kind: "user", id: "user:ada" },
			tenant: "acme",
			token: "tok",
		});
		expect(profile.session?.principal.id).toBe("user:ada");
		expect(profile.session?.issuedAt).toBeTruthy();
		expect(loadHoboProfile(dir)?.session?.token).toBe("tok");
	});

	it("keeps the previous broker when the new login names none", () => {
		// Re-logging in — after a token expires, say — carries no broker flag.
		// Dropping the broker there would send the user's next `hobo up` to the
		// local lane without a word.
		const dir = home();
		upsertLoginProfile({
			hoboHome: dir,
			principal: { kind: "user", id: "user:ada" },
			tenant: "acme",
			token: "t1",
			brokerUri: "https://first.example",
		});
		const second = upsertLoginProfile({
			hoboHome: dir,
			principal: { kind: "user", id: "user:ada" },
			tenant: "acme",
			token: "t2",
		});
		expect(second.session?.brokerUri).toBe("https://first.example");
		expect(second.defaultBrokerUri).toBe("https://first.example");
	});

	it("lets an explicit broker replace the remembered one", () => {
		// Moving between brokers is a deliberate act, and the flag is how it is
		// expressed. Preferring the stored value would make the flag inert.
		const dir = home();
		upsertLoginProfile({
			hoboHome: dir,
			principal: { kind: "user", id: "user:ada" },
			tenant: "acme",
			token: "t1",
			brokerUri: "https://first.example",
		});
		const second = upsertLoginProfile({
			hoboHome: dir,
			principal: { kind: "user", id: "user:ada" },
			tenant: "acme",
			token: "t2",
			brokerUri: "https://second.example",
		});
		expect(second.defaultBrokerUri).toBe("https://second.example");
		expect(second.session?.brokerUri).toBe("https://second.example");
	});

	it("keeps the station and rail a login was never asked to touch", () => {
		// Logging in must not un-occupy a Station. The two are set by different
		// commands and a user who runs them in the other order would otherwise
		// have to re-run `hobo station init` after every token refresh.
		const dir = home();
		setDefaultStation(dir, { id: "station:one", dataDir: "/data" }, "main");
		const profile = upsertLoginProfile({
			hoboHome: dir,
			principal: { kind: "agent", id: "agent:ci" },
			tenant: "acme",
			token: "tok",
		});
		expect(profile.defaultStation?.id).toBe("station:one");
		expect(profile.defaultStation?.dataDir).toBe("/data");
		expect(profile.activeRail).toBe("main");
	});

	it("lets an explicit stationId replace the remembered station", () => {
		const dir = home();
		setDefaultStation(dir, { id: "station:one" });
		const profile = upsertLoginProfile({
			hoboHome: dir,
			principal: { kind: "user", id: "user:ada" },
			tenant: "acme",
			token: "tok",
			stationId: "station:two",
		});
		expect(profile.defaultStation?.id).toBe("station:two");
	});

	it("records proofKeyId only when one was minted", () => {
		// The id points at key material on disk. Writing a placeholder would make
		// a later presentation look sender-constrained when it is not.
		const dir = home();
		const withKey = upsertLoginProfile({
			hoboHome: dir,
			principal: { kind: "user", id: "user:ada" },
			tenant: "acme",
			token: "tok",
			proofKeyId: "key-1",
		});
		expect(withKey.session?.proofKeyId).toBe("key-1");

		const withoutKey = upsertLoginProfile({
			hoboHome: home(),
			principal: { kind: "user", id: "user:ada" },
			tenant: "acme",
			token: "tok",
		});
		expect(withoutKey.session?.proofKeyId).toBeUndefined();
	});

	it("promotes a session broker to the default when there is no other", () => {
		// The three-way fallback ends at the session's own broker, so a profile
		// written by a flow that only set the session still answers "which broker
		// do I deploy to?" — the question `hobo up` asks on every remote run.
		const dir = home();
		saveHoboProfile(dir, {
			schemaVersion: HOBO_PROFILE_SCHEMA,
			updatedAt: "2026-01-01T00:00:00.000Z",
			session: {
				principal: { kind: "user", id: "user:ada" },
				tenant: "acme",
				token: "old",
				issuedAt: "2026-01-01T00:00:00.000Z",
				brokerUri: "https://session.example",
			},
		});
		const profile = upsertLoginProfile({
			hoboHome: dir,
			principal: { kind: "user", id: "user:ada" },
			tenant: "acme",
			token: "new",
		});
		expect(profile.defaultBrokerUri).toBe("https://session.example");
	});
});

describe("setDefaultStation", () => {
	it("writes a station into an empty home", () => {
		const dir = home();
		const profile = setDefaultStation(dir, { id: "station:one" });
		expect(profile.defaultStation?.id).toBe("station:one");
		expect(loadHoboProfile(dir)?.defaultStation?.id).toBe("station:one");
	});

	it("keeps the existing session and broker", () => {
		// Occupying a Station is not a logout. A user who initializes a Station
		// after logging in must not be sent back through the browser.
		const dir = home();
		upsertLoginProfile({
			hoboHome: dir,
			principal: { kind: "user", id: "user:ada" },
			tenant: "acme",
			token: "tok",
			brokerUri: "https://b.example",
		});
		const profile = setDefaultStation(dir, { id: "station:one" });
		expect(profile.session?.token).toBe("tok");
		expect(profile.defaultBrokerUri).toBe("https://b.example");
	});

	it("takes an explicit rail over the remembered one, and keeps it when absent", () => {
		const dir = home();
		setDefaultStation(dir, { id: "station:one" }, "main");
		expect(setDefaultStation(dir, { id: "station:one" }).activeRail).toBe(
			"main",
		);
		expect(
			setDefaultStation(dir, { id: "station:one" }, "next").activeRail,
		).toBe("next");
	});

	it("leaves the rail unset when neither call named one", () => {
		// An absent rail means "the default", which downstream resolves for
		// itself. Inventing a value here would pin every profile to whatever this
		// build happened to consider default.
		expect(
			setDefaultStation(home(), { id: "station:one" }).activeRail,
		).toBeUndefined();
	});
});
