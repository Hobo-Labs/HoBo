import type {
	ConnectionFlow,
	ConnectionPrincipalRef,
	ConnectionStatus,
	ConnectionView,
} from "@hobo/identity";
import type {
	Rail,
	RailActivationStatus,
	StationOccupancy,
} from "@hobo/stations";

export type ManagementActor = ConnectionPrincipalRef & { tenant: string };

export type ManagementHome = Readonly<{
	hoboHome: string;
	/** Optional injectables for tests. */
	now?: () => string;
}>;

export type PublicConnectionView = Readonly<{
	id: string;
	alias?: string;
	provider: string;
	flow: ConnectionFlow | string;
	status: ConnectionStatus | string;
	subject: ConnectionView["subject"];
	installationId?: string;
	grantedScopes: readonly string[];
	requestedScopes: readonly string[];
	credentialRef?: string;
	stationId: string;
	tenant: string;
	createdAt: string;
	updatedAt: string;
	// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: existing boundary or test contract.
	metadata: Readonly<Record<string, unknown>>;
}>;

export type RailPublicView = Readonly<{
	id: string;
	name: string;
	contentHash: string;
	activationStatus: RailActivationStatus;
	isBootstrap: boolean;
	quotaUsed: number;
	quotaLimit: number;
	spendCapUsd: number;
	budgetUsd: number;
}>;

/**
 * Provenance of the metering trafficRate signal (HIGHBALL "kill or badge"):
 * "synthetic" — derived from connection counts, not measured traffic;
 * "otlp" — reserved for real OTLP-derived rates once metrics flow.
 */
export type TrafficRateSource = "synthetic" | "otlp";

/**
 * Provenance of a connector activity status (HIGHBALL "kill or badge"):
 * "derived-static" — mapped statically from connection lifecycle status;
 * "otlp" — reserved for live agent telemetry once OTLP signals flow.
 */
export type ConnectorStatusSource = "derived-static" | "otlp";

export type MeteringView = Readonly<{
	quotaUsed: number;
	quotaLimit: number;
	spendCapUsd: number;
	budgetUsd: number;
	/** Synthetic traffic rate 0..1 for yard particles; derived from connections. */
	trafficRate: number;
	/**
	 * Provenance badge for trafficRate. Optional-with-default for consumers'
	 * fixtures; projectYardSnapshot always sets it ("synthetic" today).
	 */
	trafficRateSource?: TrafficRateSource;
}>;

export type ConnectorActivityView = Readonly<{
	connectorKind: string;
	status: "offline" | "idle" | "working" | "error";
	connectionId?: string;
	/**
	 * Provenance badge for status. Optional-with-default for consumers'
	 * fixtures; projectYardSnapshot always sets it ("derived-static" today).
	 */
	statusSource?: ConnectorStatusSource;
}>;

export type DoctorView = Readonly<{
	bootstrapActive: boolean;
	hazards: readonly string[];
	hint?: string;
}>;

export type YardProjectionSnapshot = Readonly<{
	occupancy: StationOccupancy;
	rails: readonly RailPublicView[];
	connections: readonly PublicConnectionView[];
	metering: MeteringView;
	activity: readonly ConnectorActivityView[];
	doctor: DoctorView;
	seq: number;
	/** Occupancy mode for game: idle | occupying when station up/down applied. */
	occupyMode: "idle" | "occupying";
}>;

export type BrokerStatusView = Readonly<{
	ok: boolean;
	stationId?: string;
	activeRailHash?: string;
	bootstrapActive?: boolean;
	connectionCount?: number;
	message: string;
}>;

export function toPublicConnection(c: ConnectionView): PublicConnectionView {
	return Object.freeze({
		id: c.id,
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(c.alias !== undefined ? { alias: c.alias } : {}),
		provider: c.provider,
		flow: c.flow,
		status: c.status,
		subject: c.subject,
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(c.installationId !== undefined
			? { installationId: c.installationId }
			: {}),
		grantedScopes: c.grantedScopes,
		requestedScopes: c.requestedScopes,
		// oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- SAFETY: existing boundary or test contract.
		...(c.credentialRef !== undefined
			? { credentialRef: c.credentialRef }
			: {}),
		stationId: c.stationId,
		tenant: c.tenant,
		createdAt: c.createdAt,
		updatedAt: c.updatedAt,
		metadata: c.metadata,
	});
}

export function toRailPublicView(r: Rail): RailPublicView {
	return Object.freeze({
		id: r.id,
		name: r.name,
		contentHash: r.contentHash,
		activationStatus: r.activationStatus,
		isBootstrap: r.isBootstrap,
		quotaUsed: r.billingPolicy.quotaUsed,
		quotaLimit: r.billingPolicy.quotaLimit,
		spendCapUsd: r.billingPolicy.spendCapUsd,
		budgetUsd: r.billingPolicy.budgetUsd,
	});
}
/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-conditional-empty-object-spread -- SAFETY: public views mirror JSON payloads and omit unset optional fields. */
