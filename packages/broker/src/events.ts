// Broker command/event families. Commands (resolve/scale/deliver/register)
// arrive at the broker actor; every decision is recorded as one of these
// facts so read models rebuild from the event store alone.

import type { JsonObject } from "./json.js";

export const BROKER_EVENTS = {
	Requested: "broker.Requested",
	Resolved: "broker.Resolved",
	Rejected: "broker.Rejected",
	ScaleRequested: "broker.ScaleRequested",
	DeliverySubmitted: "broker.DeliverySubmitted",
	ResolutionSigned: "broker.ResolutionSigned",
	EnvironmentPublished: "broker.EnvironmentPublished",
	EnvironmentApproved: "broker.EnvironmentApproved",
	ConnectorRegistered: "connector.Registered",
	ConnectorDisabled: "connector.Disabled",
} as const;

export type BrokerEventType =
	(typeof BROKER_EVENTS)[keyof typeof BROKER_EVENTS];

export interface BrokerEvent {
	type: string;
	data: JsonObject;
}

export function brokerEvent(
	type: BrokerEventType,
	data: JsonObject,
): BrokerEvent {
	return { type, data };
}
