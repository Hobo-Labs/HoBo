import { type JsonValue } from "./json.js";
export type RecordType = "A" | "AAAA" | "CNAME" | "TXT" | "CAA";

export type RoutingPolicy =
  | { kind: "failover"; targets: Array<{ camp: string; priority: number }> }
  | { kind: "weighted"; targets: Array<{ camp: string; weight: number }> }
  | { kind: "latency"; targets: Array<{ camp: string; region: string }> }
  | { kind: "geo"; targets: Array<{ camp: string; geo: string }> }
  | { kind: "cost"; targets: Array<{ camp: string; replicaClass: "active-active-eventual" | "pinned" }> };

export interface DnsTarget {
  camp: string;
  value: string;
}

export interface DnsRecord {
  name: string;
  type: RecordType;
  ttl: number;
  targets: DnsTarget[];
  policy: RoutingPolicy;
  campOverrides?: Array<{
    camp: string;
    targets: DnsTarget[];
  }>;
}

export interface DnsChange {
  zone: "shadow";
  changeId: string;
  event: {
    type: "domain.RoutingChanged" | "domain.RecordDeleted";
    domain: string;
    camp: string;
    op: "upsert" | "delete";
    record: Partial<DnsRecord>;
  };
}

export interface DnsPort {
  upsertRecord(record: DnsRecord): Promise<DnsChange>;
  readRecords(name: string): Promise<DnsRecord[]>;
  deleteRecord(name: string, recordType: RecordType): Promise<DnsChange>;
}

export interface DnsAdapter {
  id: string;
  upsertShadowRecord(domain: string, record: DnsRecord): Promise<void>;
  readShadowRecords(domain: string, name: string): Promise<DnsRecord[]>;
  deleteShadowRecord(domain: string, name: string, type: RecordType): Promise<void>;
  inspectLiveZone(domain: string): DnsRecord[];
}

export function routingPolicy(kind: RoutingPolicy["kind"], entries: JsonValue[]): RoutingPolicy;
export function createPreValidationDnsPort(input: { domain: string; camp: string; adapter: DnsAdapter }): DnsPort;
export function createInMemoryDnsAdapter(input: { id: string; shadowWritesAlsoTouchLive?: boolean }): DnsAdapter & {
  inspectShadowZone(domain: string): DnsRecord[];
};
export function runDnsConformance(adapter: DnsAdapter, input: { domain: string; camp: string }): Promise<{
  ok: boolean;
  adapterId: string;
  failures: string[];
}>;
