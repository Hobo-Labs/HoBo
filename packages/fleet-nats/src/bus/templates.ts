/**
 * The permission templates of §6.7, exactly as listed there: the three scoped
 * signing-key templates a device's credentials come from, and the static
 * users of each tenant account. `{{name()}}` expands to the user JWT's name,
 * which the callout sets to the `MemberId`.
 */
import { type MemberRecord, MemberState, Role } from "@hobo/fleet";
import { AUDIT_SUBJECTS, BUCKETS, bucketStream, STREAMS } from "./names.js";

export type DeviceTemplate = "observer" | "executor" | "dispatcher";

// public-contract: the template names are the scoped signing keys' roles in the account JWT (§6.7).
export const DEVICE_TEMPLATES: readonly DeviceTemplate[] = [
	"observer",
	"executor",
	"dispatcher",
];

export type SubjectPermissions = Readonly<{
	publish: readonly string[];
	subscribe: readonly string[];
}>;

const NAME = "{{name()}}";

const observer: SubjectPermissions = {
	publish: [
		`$KV.${BUCKETS.observations}.${NAME}.*`,
		`fleet.event.${NAME}.>`,
		"$JS.API.INFO",
		`$JS.API.STREAM.INFO.${bucketStream(BUCKETS.registry)}`,
		`$JS.API.STREAM.INFO.${bucketStream(BUCKETS.views)}`,
		`$JS.API.STREAM.INFO.${bucketStream(BUCKETS.observations)}`,
		`$JS.API.DIRECT.GET.${bucketStream(BUCKETS.registry)}.>`,
		`$JS.API.DIRECT.GET.${bucketStream(BUCKETS.views)}.>`,
		`$JS.API.DIRECT.GET.${bucketStream(BUCKETS.observations)}.>`,
		`$JS.API.CONSUMER.CREATE.${bucketStream(BUCKETS.registry)}.${NAME}.>`,
		`$JS.API.CONSUMER.CREATE.${bucketStream(BUCKETS.observations)}.${NAME}.>`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.control}.${NAME}.fleet.control.${NAME}`,
		`$JS.API.CONSUMER.MSG.NEXT.*.${NAME}`,
		`$JS.API.CONSUMER.INFO.*.${NAME}`,
		`$JS.API.CONSUMER.DELETE.*.${NAME}`,
	],
	subscribe: [`_INBOX.${NAME}.>`],
};

const executor: SubjectPermissions = {
	publish: [
		...observer.publish,
		"fleet.claim.>",
		"fleet.relay.>",
		`$JS.API.STREAM.INFO.${STREAMS.offers}`,
		`$JS.API.STREAM.INFO.${STREAMS.claims}`,
		`$JS.API.DIRECT.GET.${STREAMS.claims}.>`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.offers}.${NAME}.fleet.offer.>`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.orders}.${NAME}.fleet.order.${NAME}`,
	],
	subscribe: [...observer.subscribe, `fleet.relay.${NAME}.>`],
};

const dispatcher: SubjectPermissions = {
	publish: [
		...executor.publish,
		"fleet.offer.>",
		"fleet.order.>",
		`$JS.API.STREAM.MSG.DELETE.${STREAMS.claims}`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.claims}.${NAME}.fleet.claim.>`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.events}.${NAME}.fleet.event.>`,
		`$JS.API.CONSUMER.CREATE.${STREAMS.submissions}.${NAME}.fleet.submission.>`,
	],
	subscribe: executor.subscribe,
};

export const TEMPLATES = {
	observer,
	executor,
	dispatcher,
} satisfies Readonly<Record<DeviceTemplate, SubjectPermissions>>;

/** The template's subjects with `{{name()}}` expanded, as the server applies them to one connection. */
export function expandTemplate(
	template: DeviceTemplate,
	name: string,
): SubjectPermissions {
	const expand = (subject: string) => subject.replaceAll(NAME, name);
	return {
		publish: TEMPLATES[template].publish.map(expand),
		subscribe: TEMPLATES[template].subscribe.map(expand),
	};
}

/**
 * The highest template any of the member's fleet memberships grants
 * (dispatcher, then executor, then observer; reconcilers and junctions are
 * observers), or undefined for a member that holds no role or is not active.
 */
export function templateFor(record: MemberRecord): DeviceTemplate | undefined {
	if (record.state !== MemberState.ACTIVE) return undefined;
	const roles = new Set(record.memberships.flatMap((m) => m.roles));
	if (roles.has(Role.DISPATCHER)) return "dispatcher";
	if (roles.has(Role.EXECUTOR)) return "executor";
	if (
		roles.has(Role.OBSERVER) ||
		roles.has(Role.RECONCILER) ||
		roles.has(Role.JUNCTION)
	)
		return "observer";
	return undefined;
}

// public-contract: the static users of every tenant account (§6.7).
export const STATIC_USERS = [
	"authority",
	"witness",
	"provisioner",
	"sentinel",
] as const;
export type StaticUser = (typeof STATIC_USERS)[number];

const FLEET_STREAMS = Object.values(STREAMS);
const FLEET_BUCKET_STREAMS = Object.values(BUCKETS).map(bucketStream);
const ALL_FLEET_STREAMS = [...FLEET_STREAMS, ...FLEET_BUCKET_STREAMS];

/**
 * The static users' permissions. The authority may manage consumers and read
 * and write every fleet subject and bucket, but never create, update, delete
 * or purge a stream; only the provisioner administers streams.
 */
export type StaticPermissions = SubjectPermissions &
	Readonly<{
		denyPublish: readonly string[];
		/** May answer requests sent to it (the callout responder answers the server). */
		allowResponses: boolean;
	}>;

export function staticUserPermissions(user: StaticUser): StaticPermissions {
	switch (user) {
		case "authority":
			return {
				publish: [
					"fleet.>",
					"$JS.API.INFO",
					...Object.values(BUCKETS).map((bucket) => `$KV.${bucket}.>`),
					...ALL_FLEET_STREAMS.flatMap((stream) => [
						`$JS.API.STREAM.INFO.${stream}`,
						`$JS.API.STREAM.MSG.GET.${stream}`,
						`$JS.API.STREAM.MSG.DELETE.${stream}`,
						`$JS.API.DIRECT.GET.${stream}`,
						`$JS.API.DIRECT.GET.${stream}.>`,
					]),
					"$JS.API.CONSUMER.>",
					"$SYS.REQ.SERVER.PING.CONNZ",
				],
				subscribe: ["fleet.>", "_INBOX.>", "$SYS.REQ.USER.AUTH"],
				denyPublish: [
					"$JS.API.STREAM.CREATE.>",
					"$JS.API.STREAM.UPDATE.>",
					"$JS.API.STREAM.DELETE.>",
					"$JS.API.STREAM.PURGE.>",
				],
				allowResponses: true,
			};
		case "witness":
			return {
				publish: [
					AUDIT_SUBJECTS.witness,
					"$JS.API.INFO",
					`$JS.API.STREAM.INFO.${STREAMS.audit}`,
					`$JS.API.STREAM.INFO.${bucketStream(BUCKETS.registry)}`,
					`$JS.API.DIRECT.GET.${STREAMS.audit}.>`,
					`$JS.API.DIRECT.GET.${bucketStream(BUCKETS.registry)}.>`,
					`$JS.API.CONSUMER.CREATE.${STREAMS.audit}.>`,
					`$JS.API.CONSUMER.CREATE.${bucketStream(BUCKETS.registry)}.>`,
					"$JS.API.CONSUMER.MSG.NEXT.>",
					"$JS.API.CONSUMER.INFO.>",
					"$JS.API.CONSUMER.DELETE.>",
				],
				subscribe: ["_INBOX.>"],
				denyPublish: [],
				allowResponses: false,
			};
		case "provisioner":
			return {
				publish: [
					"$JS.API.INFO",
					...ALL_FLEET_STREAMS.flatMap((stream) => [
						`$JS.API.STREAM.CREATE.${stream}`,
						`$JS.API.STREAM.UPDATE.${stream}`,
						`$JS.API.STREAM.INFO.${stream}`,
						`$JS.API.STREAM.DELETE.${stream}`,
					]),
					"$JS.API.STREAM.NAMES",
					"$JS.API.STREAM.LIST",
				],
				subscribe: ["_INBOX.>"],
				denyPublish: [],
				allowResponses: false,
			};
		case "sentinel":
			return {
				publish: [],
				subscribe: [],
				denyPublish: [">"],
				allowResponses: false,
			};
	}
}
