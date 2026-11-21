import type { OpenedSecretStore } from "@hobo/hobo-ci";
import { familySettings } from "@hobo/hobo-ci";

import { cdJournalContinuity } from "./continuity.js";
import { CD_JOURNAL_MEMBER_PLANS } from "./fleet-plans.js";

// `hobo cd up` provisions the CD journal's fleet: the members its continuity
// policy asks for (a writer and `standbys` standbys) and one witness, which
// holds the register's majority vote and the scheduled backups.
//
// Each member is a database a provisioner creates (Neon Claimable Postgres by
// default: no account, nothing to sign up for). Its connection string goes
// straight into the owner's secret store, at the entry the CD runtime reads
// (`HOBO_CD_POSTGRES_URL_<ID>`), with its claim link beside it
// (`HOBO_CD_POSTGRES_CLAIM_<ID>`), so it never passes through a page, a file
// or a result. The fleet's roster, member ids with their plans, is kept as a
// non-secret setting (`HOBO_CD_SETTINGS`), so a destroyed devbox runs the
// same fleet after signing in.
//
// Idempotent and resumable: an entry the store already holds is kept, so a
// re-run creates only what an interrupted run did not, and a complete fleet
// creates nothing. With several provisioners, members go round-robin across
// them for vendor spread.

// public-contract: the CD runtime parses the fleet's members from this setting.
export const JOURNAL_FLEET_SETTING = "HOBO_CD_POSTGRES_FLEET";
// public-contract: the CD runtime parses the fleet's witnesses from this setting.
export const JOURNAL_WITNESS_SETTING = "HOBO_CD_POSTGRES_WITNESSES";

/** Creates one database for a fleet member. */
export interface JournalMemberProvisioner {
	/** The member plan (`CD_JOURNAL_MEMBER_PLANS`) its databases run on. */
	readonly plan: string;
	create(input: {
		readonly member: string;
		/** Stable for this member of this fleet: a retry adopts, never duplicates. */
		readonly idempotencyKey: string;
		/** The owner's store: where a provisioner keeps its durable claim. */
		readonly store: OpenedSecretStore;
	}): Promise<{
		readonly connectionString: string;
		readonly claimUrl?: string;
	}>;
}

export type JournalFleetMember = Readonly<{ id: string; plan: string }>;

export type JournalFleetLayout = Readonly<{
	members: readonly JournalFleetMember[];
	witnesses: readonly JournalFleetMember[];
}>;

/** The entry holding a member's connection string (`neon-eu` → `HOBO_CD_POSTGRES_URL_NEON_EU`). */
export function journalMemberUrlEntry(id: string): string {
	return `HOBO_CD_POSTGRES_URL_${id.toUpperCase().replaceAll("-", "_")}`;
}

/** The entry holding a member's claim link. */
export function journalMemberClaimEntry(id: string): string {
	return `HOBO_CD_POSTGRES_CLAIM_${id.toUpperCase().replaceAll("-", "_")}`;
}

/** The members and witness the journal's policy asks for, spread across the provisioners. */
export function journalFleetLayout(
	provisioners: readonly JournalMemberProvisioner[],
): JournalFleetLayout {
	if (provisioners.length === 0)
		throw new Error("the journal fleet needs at least one provisioner");
	const count = 1 + cdJournalContinuity().standbys;
	const planAt = (index: number) =>
		provisioners[index % provisioners.length]?.plan ?? "";
	return {
		members: Array.from({ length: count }, (_, index) => ({
			id: `journal-${index + 1}`,
			plan: planAt(index),
		})),
		witnesses: [{ id: "journal-witness", plan: planAt(count) }],
	};
}

const entry = (member: JournalFleetMember) => `${member.id}:${member.plan}`;

function parseEntries(text: string | undefined): readonly JournalFleetMember[] {
	return (text ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "")
		.map((part) => {
			const [id = "", plan = ""] = part.split(":");
			return { id, plan };
		});
}

export type JournalFleetStep = Readonly<{
	id: "cd-journal";
	outcome: "created" | "unchanged" | "would-create";
	detail: string;
}>;

async function holds(store: OpenedSecretStore, name: string): Promise<boolean> {
	const read = await store.port.access(name);
	if (read.status === "ok") return Boolean(read.material);
	if (read.code === "secret-not-found") return false;
	throw new Error(`Cannot read ${store.reference(name)}.`);
}

/** Provision what the journal's fleet is missing (see the module comment). */
export async function prepareJournalFleet(input: {
	readonly store: OpenedSecretStore;
	readonly provisioners: readonly JournalMemberProvisioner[];
	readonly whatIf?: boolean;
}): Promise<JournalFleetStep> {
	const { store } = input;
	const settings = familySettings(store, "cd");
	const saved = await settings.read();
	const layout: JournalFleetLayout =
		saved[JOURNAL_FLEET_SETTING] !== undefined
			? {
					members: parseEntries(saved[JOURNAL_FLEET_SETTING]),
					witnesses: parseEntries(saved[JOURNAL_WITNESS_SETTING]),
				}
			: journalFleetLayout(input.provisioners);
	const all = [...layout.members, ...layout.witnesses];
	for (const member of all)
		if (CD_JOURNAL_MEMBER_PLANS[member.plan] === undefined)
			throw new Error(
				`fleet member ${member.id} names plan ${member.plan}, which no provisioner here serves`,
			);
	const missing: JournalFleetMember[] = [];
	for (const member of all)
		if (!(await holds(store, journalMemberUrlEntry(member.id))))
			missing.push(member);
	const roster = `${layout.members.map(entry).join(", ")}; witness ${layout.witnesses.map(entry).join(", ")}`;
	const unchangedSettings = saved[JOURNAL_FLEET_SETTING] !== undefined;
	if (missing.length === 0 && unchangedSettings)
		return {
			id: "cd-journal",
			outcome: "unchanged",
			detail: `fleet ${roster}; connection strings in ${store.id}`,
		};
	if (input.whatIf)
		return {
			id: "cd-journal",
			outcome: "would-create",
			detail: `would create ${missing.map((member) => member.id).join(", ") || "nothing"} and keep the fleet ${roster} in ${store.id}`,
		};
	for (const member of missing) {
		const provisioner = input.provisioners.find(
			(candidate) => candidate.plan === member.plan,
		);
		if (provisioner === undefined)
			throw new Error(
				`no provisioner here creates ${member.plan} databases for ${member.id}`,
			);
		const created = await provisioner.create({
			member: member.id,
			idempotencyKey: `hobo-cd-journal:${member.id}`,
			store,
		});
		if (!/^postgres(ql)?:\/\//u.test(created.connectionString))
			throw new Error(
				`the ${member.plan} database for ${member.id} came back without a PostgreSQL connection string`,
			);
		// The claim link first: a member whose URL is stored is complete.
		if (created.claimUrl !== undefined)
			await store.port.put(
				journalMemberClaimEntry(member.id),
				created.claimUrl,
			);
		await store.port.put(
			journalMemberUrlEntry(member.id),
			created.connectionString,
		);
	}
	await settings.write({
		...saved,
		[JOURNAL_FLEET_SETTING]: layout.members.map(entry).join(","),
		[JOURNAL_WITNESS_SETTING]: layout.witnesses.map(entry).join(","),
	});
	const claims =
		missing.length > 0
			? ` Claim each new database to keep it (an unclaimed one expires): the links are in ${store.id} at ${missing.map((member) => store.reference(journalMemberClaimEntry(member.id))).join(", ")}.`
			: "";
	return {
		id: "cd-journal",
		outcome: missing.length > 0 ? "created" : "unchanged",
		detail: `fleet ${roster}; connection strings in ${store.id}.${claims}`,
	};
}

/**
 * The journal fleet's settings and secret reader for the CD runtime: the
 * fleet's roster as the non-secret settings it parses, and its connection
 * strings read from the store when the journal opens.
 */
export async function journalFleetRuntime(store: OpenedSecretStore): Promise<{
	readonly env: Readonly<Record<string, string>>;
	readonly readSecret: (entry: string) => Promise<string | undefined>;
}> {
	const saved = await familySettings(store, "cd").read();
	return {
		env: Object.fromEntries(
			[JOURNAL_FLEET_SETTING, JOURNAL_WITNESS_SETTING].flatMap((name) => {
				const value = saved[name];
				return value === undefined ? [] : [[name, value]];
			}),
		),
		readSecret: async (name) => {
			const read = await store.port.access(name);
			return read.status === "ok" && read.material ? read.material : undefined;
		},
	};
}
