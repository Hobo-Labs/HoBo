/**
 * Camp tiers: the standard segmentation of a workload into units that are
 * secured, deployed, and blast-radius-bounded as one.
 *
 * ## What a tier is, and why it is a Camp rather than a label
 *
 * Azure's Well-Architected SE:04 defines a segment as "a logical section of
 * your solution that needs to be secured as one unit", and names "application
 * tiers that isolate by workload utility" as one of its examples. AWS's
 * SEC05-BP01 says the same thing from the network side: "Segment your network
 * topology into different layers based on logical groupings of your workload
 * components according to their data sensitivity and access requirements."
 *
 * A Camp is HoBo's deployment target — the thing a Bindle is placed into and
 * the thing controls attach to. So a tier *is* a Camp, not a label on one. If
 * tier were a label, every tier would share a placement target, which is
 * exactly the anti-pattern SEC05-BP01 names first: "You create all resources in
 * a single VPC or subnet."
 *
 * ## The three grouping criteria, taken from SEC05-BP01
 *
 * A component belongs in a tier by:
 *
 * 1. **Function** — what responsibility it serves ("presentation layer,
 *    application layer, and data layer").
 * 2. **Data sensitivity** — "different services may process data with different
 *    sensitivity levels", which can justify splitting one functional tier.
 * 3. **Behaviour** — services taking "inherently riskier" input ("file uploads,
 *    code scripts to run, email scanning") get their own boundary so their
 *    behaviour cannot mask or trip inspection on the rest.
 *
 * Criterion 3 is why {@link CAMP_TIERS.untrusted} exists as a named tier rather
 * than being folded into `app`.
 *
 * ## Why only three are default
 *
 * SE:04 records the countervailing risk in as many words: "Micro-segmentation
 * beyond a reasonable limit loses the benefit of isolation. When you create too
 * many segments, it becomes difficult to identify points of communication or to
 * allow for valid communication paths within the segment." It also names a cost
 * tradeoff, since side-by-side segments provision more resources.
 *
 * So {@link DEFAULT_CAMP_TIERS} is the three-tier shape both frameworks reach
 * for by default, and `untrusted` / `ops` are standard-but-opt-in: available by
 * name, applied when the workload actually earns them.
 *
 * ## Tiers are segments, not trust boundaries
 *
 * HoBo's posture is zero-trust with "no ambient trust, no implicit network
 * perimeter" (ADR-0023), which at first reading sits badly with a tier called
 * `edge`. Both frameworks resolve it the same way and so does this module.
 * SE:04: "Identity perimeters are network agnostic while network perimeters
 * augment identity but never replace it." AWS SEC05 opens by saying components
 * are "considered discrete from each other and no component or microservice
 * trusts any other."
 *
 * A tier therefore buys **containment**, not trust. Being in `app` never means a
 * caller skips authentication; it means a breach in `edge` does not
 * automatically reach `data`. Anything that treated tier membership as a reason
 * to relax authn/authz would contradict ADR-0023 and is out of scope for this
 * vocabulary.
 *
 * ## What is deliberately NOT a tier
 *
 * **Availability clusters.** Fault isolation across zones, regions, and cells is
 * AWS REL10 ("Use fault isolation to protect your workload": deploy to multiple
 * locations, bulkhead architectures). That is a placement-and-redundancy axis,
 * and in HoBo a Yard already carries `regions`. Modelling it as a tier would
 * multiply Camps by zone count — three tiers across three zones is nine Camps
 * describing three segments — and land squarely in SE:04's over-segmentation
 * risk. Availability belongs on the Yard.
 *
 * **Environments.** `production` / `staging` / `ephemeral` / `development` are a
 * separate axis (`ENV_TYPES`), and SE:04 lists them separately too: "Deployment
 * environments that isolate deployment by stages." Tier and environment are
 * orthogonal — a production `data` Camp and a staging `data` Camp are both real
 * and both needed.
 */

/**
 * The named tiers. Values are the wire form and appear in Camp ids, so they are
 * short, lower-case, and stable.
 */
import { isJsonString, type JsonValue } from "../json.js";

export const CAMP_TIERS = Object.freeze({
	/**
	 * Internet-facing ingress: the only tier that accepts unsolicited public
	 * traffic. CDN, load balancer, API gateway, static assets, WAF.
	 *
	 * This is the position SEC05-BP01 describes as "an Amazon VPC public subnet
	 * (similar to a demilitarized zone, or DMZ)" and SE:04 as "Implement
	 * demilitarized zones (DMZs) in front of the application with proper
	 * controls via firewalls". `edge` is preferred over `dmz` as the name
	 * because a DMZ historically implied a trusted interior behind it, which is
	 * the assumption ADR-0023 rejects — the containment role is identical, the
	 * implied trust is not.
	 */
	edge: "edge",

	/**
	 * Business logic. Private by construction: no inbound path from the
	 * internet, reached only through `edge` or another internal caller.
	 *
	 * SEC05-BP01's "back-end services deployed into private subnets"; SE:04's
	 * application tier. This is the "business layer" of classic N-tier, named
	 * for where it runs rather than for the code that runs there.
	 */
	app: "app",

	/**
	 * Persistence and the state services around it: databases, caches, queues,
	 * object stores, search indexes.
	 *
	 * SEC05-BP01 is explicit that this is its own layer and not merely another
	 * private subnet alongside `app`: "The data layer, that is hosting resources
	 * such as databases and shared file systems, can reside in different private
	 * subnets from the resources of your application layer."
	 *
	 * Note this is the *deployment* tier that holds stores. A "data access
	 * layer" in the N-tier sense is application code and belongs in `app`; the
	 * store it talks to belongs here. Keeping that distinction is the point —
	 * putting the accessor with the store would defeat the boundary.
	 */
	data: "data",

	/**
	 * Workloads whose *input* is the risk: user file uploads, code execution,
	 * document/email parsing, anything running generated or unattested code.
	 *
	 * SEC05-BP01 names this case directly — services with "inherently riskier"
	 * inputs "in their own network layer helps create a stronger isolation
	 * boundary around them, and can prevent their unique behavior from creating
	 * false positive alerts in inspection systems."
	 *
	 * HoBo has a second, harder reason: ADR-0024 makes a microVM the
	 * non-overridable floor for AI-generated or unattested code. A tier that
	 * collects exactly those workloads gives that floor one place to be
	 * enforced rather than scattering it across `app`.
	 *
	 * Not in {@link DEFAULT_CAMP_TIERS}: a workload that runs no untrusted code
	 * should not provision a segment for it.
	 */
	untrusted: "untrusted",

	/**
	 * Operational surfaces kept off the workload's own path: build and deploy
	 * runners, bastion/jump access, log and metric collection, backup jobs.
	 *
	 * SE:04: "segment workload functional networks from operational networks."
	 * Separating them means an operational credential's blast radius is not the
	 * production data path.
	 *
	 * Not in {@link DEFAULT_CAMP_TIERS}: many workloads consume operations from
	 * a platform rather than running their own, and an empty `ops` Camp is a
	 * segment with nothing to contain.
	 */
	ops: "ops",
} as const);

export type CampTier = (typeof CAMP_TIERS)[keyof typeof CAMP_TIERS];

/**
 * Every named tier, ordered by containment depth along the request path:
 * `edge` takes public traffic, `app` is reachable only from inside, `data`
 * holds state and calls nothing.
 *
 * `untrusted` and `ops` sit *after* that spectrum rather than on it, and the
 * distinction is worth stating because getting it wrong produces a graph that
 * contradicts itself. `untrusted` is not "more protected than `data`" — it is
 * a quarantine, contained *from* the rest rather than protected *by* it, and
 * both `edge` (an upload arrives) and `app` (a job runs generated code)
 * legitimately hand work to it. Placing it mid-spectrum would make one of those
 * two edges look like a reversal. `ops` is off the request path entirely.
 */
export const CAMP_TIER_ORDER: readonly CampTier[] = Object.freeze([
	CAMP_TIERS.edge,
	CAMP_TIERS.app,
	CAMP_TIERS.data,
	CAMP_TIERS.untrusted,
	CAMP_TIERS.ops,
]);

/**
 * The tiers a workload gets when it says nothing.
 *
 * Three, matching the shape both frameworks reach for first — SEC05-BP01's
 * "presentation layer, application layer, and data layer", SE:04's web/database
 * split — and stopping there because SE:04 also warns that segmenting past a
 * reasonable limit loses the benefit.
 */
export const DEFAULT_CAMP_TIERS: readonly CampTier[] = Object.freeze([
	CAMP_TIERS.edge,
	CAMP_TIERS.app,
	CAMP_TIERS.data,
]);

/** True when `value` is a named tier. */
export function isCampTier(value: JsonValue | undefined): value is CampTier {
	return (
		isJsonString(value) &&
		// SAFETY: assertion required at this I/O or test boundary.
		(CAMP_TIER_ORDER as readonly string[]).includes(value)
	);
}

/**
 * Which tiers a tier may open a connection *to*.
 *
 * This is the containment half of SE:04 — "the exit edge of a segment that
 * prevents lateral movement" — expressed as data so a Yard/Camp compiler can
 * derive rules from it rather than each provider adapter inventing its own.
 *
 * It is deliberately a DAG with no cycles and no upward edges: `data` never
 * calls `app`, and nothing calls `edge`. A store that calls back into business
 * logic is the inversion that makes a breach in `data` reach everything, and
 * the shape refuses to describe it.
 *
 * This says what is *reachable*, never what is *permitted without
 * authentication* — every hop still authenticates (ADR-0023). An absent edge is
 * a hard no; a present edge is "may be allowed, subject to policy".
 */
export const CAMP_TIER_EGRESS: Readonly<Record<CampTier, readonly CampTier[]>> =
	Object.freeze({
		edge: Object.freeze([CAMP_TIERS.app, CAMP_TIERS.untrusted]),
		untrusted: Object.freeze([]),
		app: Object.freeze([CAMP_TIERS.data, CAMP_TIERS.untrusted]),
		data: Object.freeze([]),
		ops: Object.freeze([
			CAMP_TIERS.edge,
			CAMP_TIERS.app,
			CAMP_TIERS.data,
			CAMP_TIERS.untrusted,
		]),
	});
