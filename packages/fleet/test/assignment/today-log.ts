/**
 * Today's stored-log codec, copied as a test fixture (design §10.1, O15).
 *
 * `encodeTodayLog` and `decodeTodayLog` are `encodeAssignmentLog` and
 * `decodeAssignmentLog` of `packages/backend-routing/src/ephemeral-replica.ts`
 * as of the fleet contract commit, over the descriptor of today's
 * `hobo.backend_fleet.v1.FleetAssignmentLog` (copied from its generated file,
 * so this fixture keeps reading as the previous relay reads even after that
 * package is trimmed). They return plain records: the format tests compare
 * what each side wrote and read, not the parsing rules, which the register
 * tests cover.
 */
import {
	create,
	fromJsonString,
	type Message,
	toJsonString,
} from "@bufbuild/protobuf";
import {
	fileDesc,
	type GenFile,
	type GenMessage,
	messageDesc,
} from "@bufbuild/protobuf/codegenv2";

type TodayWireEntry = Message<"hobo.backend_fleet.v1.FleetAssignment"> & {
	epoch: bigint;
	active?: string | undefined;
	sealed: boolean;
	target?: string | undefined;
	reason: string;
	lossWindowMs?: bigint | undefined;
	decidedAtMs: bigint;
	decidedBy: string;
};
type TodayWireLog = Message<"hobo.backend_fleet.v1.FleetAssignmentLog"> & {
	format: number;
	entries: TodayWireEntry[];
};

const todayFile: GenFile = fileDesc(
	"ChNiYWNrZW5kX2ZsZWV0LnByb3RvEhVob2JvLmJhY2tlbmRfZmxlZXQudjEi2wEKD0ZsZWV0QXNzaWdubWVudBINCgVlcG9jaBgBIAEoBBITCgZhY3RpdmUYAiABKAlIAIgBARIOCgZzZWFsZWQYAyABKAgSEwoGdGFyZ2V0GAQgASgJSAGIAQESDgoGcmVhc29uGAUgASgJEhsKDmxvc3Nfd2luZG93X21zGAYgASgESAKIAQESFQoNZGVjaWRlZF9hdF9tcxgHIAEoBBISCgpkZWNpZGVkX2J5GAggASgJQgkKB19hY3RpdmVCCQoHX3RhcmdldEIRCg9fbG9zc193aW5kb3dfbXMiXQoSRmxlZXRBc3NpZ25tZW50TG9nEg4KBmZvcm1hdBgBIAEoDRI3CgdlbnRyaWVzGAIgAygLMiYuaG9iby5iYWNrZW5kX2ZsZWV0LnYxLkZsZWV0QXNzaWdubWVudCJaChVGbGVldFVzYWdlTWVhc3VyZW1lbnQSMwoEdW5pdBgBIAEoDjIlLmhvYm8uYmFja2VuZF9mbGVldC52MS5GbGVldFVzYWdlVW5pdBIMCgR1c2VkGAIgASgEIq8CChBGbGVldE9ic2VydmF0aW9uEg8KB2JhY2tlbmQYASABKAkSOQoGaGVhbHRoGAIgASgOMikuaG9iby5iYWNrZW5kX2ZsZWV0LnYxLkZsZWV0QmFja2VuZEhlYWx0aBIdChBwcm9iZV9sYXRlbmN5X21zGAMgASgESACIAQESFgoOZmFpbGluZ19mb3JfbXMYBCABKAQSFgoOc2NoZW1hX2N1cnJlbnQYBSABKAgSGwoOc3RhbmRieV9sYWdfbXMYBiABKARIAYgBARI7CgV1c2FnZRgHIAMoCzIsLmhvYm8uYmFja2VuZF9mbGVldC52MS5GbGVldFVzYWdlTWVhc3VyZW1lbnRCEwoRX3Byb2JlX2xhdGVuY3lfbXNCEQoPX3N0YW5kYnlfbGFnX21zIuQBCg5GbGVldEFsbG93YW5jZRIzCgR1bml0GAEgASgOMiUuaG9iby5iYWNrZW5kX2ZsZWV0LnYxLkZsZWV0VXNhZ2VVbml0EhUKCGluY2x1ZGVkGAIgASgESACIAQESNwoGYmV5b25kGAMgASgOMicuaG9iby5iYWNrZW5kX2ZsZWV0LnYxLkZsZWV0T3ZlcmFnZUtpbmQSJAoXbWV0ZXJlZF9taWNyb3NfcGVyX3VuaXQYBCABKAFIAYgBAUILCglfaW5jbHVkZWRCGgoYX21ldGVyZWRfbWljcm9zX3Blcl91bml0IjQKDUZsZWV0RXZpZGVuY2USDgoGc291cmNlGAEgASgJEhMKC29ic2VydmVkX2F0GAIgASgJIusBChNGbGVldEZpbmFuY2lhbE1vZGVsEg8KB2JhY2tlbmQYASABKAkSDAoEcGxhbhgCIAEoCRIlChhmaXhlZF9tb250aGx5X2ZlZV9taWNyb3MYAyABKARIAIgBARI5CgphbGxvd2FuY2VzGAQgAygLMiUuaG9iby5iYWNrZW5kX2ZsZWV0LnYxLkZsZWV0QWxsb3dhbmNlEjYKCGV2aWRlbmNlGAUgASgLMiQuaG9iby5iYWNrZW5kX2ZsZWV0LnYxLkZsZWV0RXZpZGVuY2VCGwoZX2ZpeGVkX21vbnRobHlfZmVlX21pY3JvcyLSAQoORmxlZXRDYW5kaWRhdGUSDwoHYmFja2VuZBgBIAEoCRIQCghlbGlnaWJsZRgCIAEoCBI8CgtmZWFzaWJpbGl0eRgDIAEoDjInLmhvYm8uYmFja2VuZF9mbGVldC52MS5GbGVldEZlYXNpYmlsaXR5EhMKBmxhZ19tcxgEIAEoBEgAiAEBEhsKDmV4aGF1c3RzX2luX21zGAUgASgESAGIAQESDwoHcmVhc29ucxgGIAMoCUIJCgdfbGFnX21zQhEKD19leGhhdXN0c19pbl9tcyKlAgoNRmxlZXREZWNpc2lvbhIyCgZhY3Rpb24YASABKA4yIi5ob2JvLmJhY2tlbmRfZmxlZXQudjEuRmxlZXRBY3Rpb24SDQoFZXBvY2gYAiABKAQSEwoGd3JpdGVyGAMgASgJSACIAQESEwoGdGFyZ2V0GAQgASgJSAGIAQESGwoObG9zc193aW5kb3dfbXMYBSABKARIAogBARIPCgdyZWFzb25zGAYgAygJEjkKCmNhbmRpZGF0ZXMYByADKAsyJS5ob2JvLmJhY2tlbmRfZmxlZXQudjEuRmxlZXRDYW5kaWRhdGUSFQoNZGVjaWRlZF9hdF9tcxgIIAEoBEIJCgdfd3JpdGVyQgkKB190YXJnZXRCEQoPX2xvc3Nfd2luZG93X21zIqQBCgpGbGVldE9mZmVyEjkKBW1vZGVsGAEgASgLMiouaG9iby5iYWNrZW5kX2ZsZWV0LnYxLkZsZWV0RmluYW5jaWFsTW9kZWwSMwoEdGllchgCIAEoDjIlLmhvYm8uYmFja2VuZF9mbGVldC52MS5GbGVldE9mZmVyVGllchIXCgpjYXBfbWljcm9zGAMgASgESACIAQFCDQoLX2NhcF9taWNyb3MicgoRRmxlZXRSb3V0aW5nTWFya3MSEQoJc3dpdGNoX2F0GAEgASgBEhkKEXN3aXRjaF9iYWNrX2JlbG93GAIgASgBEhQKDG1pbl9kd2VsbF9tcxgDIAEoBBIZChFmYWlsb3Zlcl9hZnRlcl9tcxgEIAEoBCKCAgoTRmxlZXRSb3V0ZUNhbmRpZGF0ZRIPCgdiYWNrZW5kGAEgASgJEjgKBHRpZXIYAiABKA4yJS5ob2JvLmJhY2tlbmRfZmxlZXQudjEuRmxlZXRPZmZlclRpZXJIAIgBARIQCghlbGlnaWJsZRgDIAEoCBIfChJwcm9qZWN0ZWRfZnJhY3Rpb24YBCABKAFIAYgBARIiChVwcm9qZWN0ZWRfY29zdF9taWNyb3MYBSABKARIAogBARIPCgdyZWFzb25zGAYgAygJQgcKBV90aWVyQhUKE19wcm9qZWN0ZWRfZnJhY3Rpb25CGAoWX3Byb2plY3RlZF9jb3N0X21pY3JvcyL3AQoKRmxlZXRSb3V0ZRIyCgZhY3Rpb24YASABKA4yIi5ob2JvLmJhY2tlbmRfZmxlZXQudjEuRmxlZXRBY3Rpb24SDQoFZXBvY2gYAiABKAQSEwoGYWN0aXZlGAMgASgJSACIAQESEwoGdGFyZ2V0GAQgASgJSAGIAQESDwoHcmVhc29ucxgFIAMoCRI+CgpjYW5kaWRhdGVzGAYgAygLMiouaG9iby5iYWNrZW5kX2ZsZWV0LnYxLkZsZWV0Um91dGVDYW5kaWRhdGUSFQoNZGVjaWRlZF9hdF9tcxgHIAEoBEIJCgdfYWN0aXZlQgkKB190YXJnZXQqzwIKDkZsZWV0VXNhZ2VVbml0EiAKHEZMRUVUX1VTQUdFX1VOSVRfVU5TUEVDSUZJRUQQABIfChtGTEVFVF9VU0FHRV9VTklUX09QRVJBVElPTlMQARIiCh5GTEVFVF9VU0FHRV9VTklUX0NPTVBVVEVfSE9VUlMQAhIiCh5GTEVFVF9VU0FHRV9VTklUX1NUT1JBR0VfQllURVMQAxIdChlGTEVFVF9VU0FHRV9VTklUX0NPTU1BTkRTEAQSHgoaRkxFRVRfVVNBR0VfVU5JVF9ST1dTX1JFQUQQBRIhCh1GTEVFVF9VU0FHRV9VTklUX1JPV1NfV1JJVFRFThAGEiYKIkZMRUVUX1VTQUdFX1VOSVRfU0lNUExFX09QRVJBVElPTlMQBxIoCiRGTEVFVF9VU0FHRV9VTklUX0FEVkFOQ0VEX09QRVJBVElPTlMQCCrvAQoSRmxlZXRCYWNrZW5kSGVhbHRoEiQKIEZMRUVUX0JBQ0tFTkRfSEVBTFRIX1VOU1BFQ0lGSUVEEAASIgoeRkxFRVRfQkFDS0VORF9IRUFMVEhfUkVBQ0hBQkxFEAESJAogRkxFRVRfQkFDS0VORF9IRUFMVEhfVU5SRUFDSEFCTEUQAhIoCiRGTEVFVF9CQUNLRU5EX0hFQUxUSF9RVU9UQV9FWEhBVVNURUQQAxIdChlGTEVFVF9CQUNLRU5EX0hFQUxUSF9BVVRIEAQSIAocRkxFRVRfQkFDS0VORF9IRUFMVEhfVU5LTk9XThAFKpgBChBGbGVldE92ZXJhZ2VLaW5kEiIKHkZMRUVUX09WRVJBR0VfS0lORF9VTlNQRUNJRklFRBAAEiAKHEZMRUVUX09WRVJBR0VfS0lORF9IQVJEX1NUT1AQARIeChpGTEVFVF9PVkVSQUdFX0tJTkRfTUVURVJFRBACEh4KGkZMRUVUX09WRVJBR0VfS0lORF9VTktOT1dOEAMqlgEKEEZsZWV0RmVhc2liaWxpdHkSIQodRkxFRVRfRkVBU0lCSUxJVFlfVU5TUEVDSUZJRUQQABIeChpGTEVFVF9GRUFTSUJJTElUWV9GRUFTSUJMRRABEh0KGUZMRUVUX0ZFQVNJQklMSVRZX1VOS05PV04QAhIgChxGTEVFVF9GRUFTSUJJTElUWV9JTkZFQVNJQkxFEAMqjQEKC0ZsZWV0QWN0aW9uEhwKGEZMRUVUX0FDVElPTl9VTlNQRUNJRklFRBAAEhUKEUZMRUVUX0FDVElPTl9LRUVQEAESFQoRRkxFRVRfQUNUSU9OX0hPTEQQAhIXChNGTEVFVF9BQ1RJT05fU1dJVENIEAMSGQoVRkxFRVRfQUNUSU9OX0ZBSUxPVkVSEAQqhgEKDkZsZWV0T2ZmZXJUaWVyEiAKHEZMRUVUX09GRkVSX1RJRVJfVU5TUEVDSUZJRUQQABIZChVGTEVFVF9PRkZFUl9USUVSX0ZSRUUQARIcChhGTEVFVF9PRkZFUl9USUVSX1BSRVBBSUQQAhIZChVGTEVFVF9PRkZFUl9USUVSX1BBWUcQA2IGcHJvdG8z",
);
const TodayEntrySchema: GenMessage<TodayWireEntry> = messageDesc(todayFile, 0);
const TodayLogSchema: GenMessage<TodayWireLog> = messageDesc(todayFile, 1);

/** domain-view: today's FleetAssignment, as plain values. */
export type TodayEntry = Readonly<{
	epoch: number;
	active: string | undefined;
	sealed: boolean;
	target: string | undefined;
	reason: string;
	lossWindowMs: number | undefined;
	decidedAtMs: number;
	decidedBy: string;
}>;

const LOG_FORMAT = 1;

/** Today's encodeAssignmentLog. */
export function encodeTodayLog(entries: readonly TodayEntry[]): string {
	return toJsonString(
		TodayLogSchema,
		create(TodayLogSchema, {
			format: LOG_FORMAT,
			entries: entries.map((entry) =>
				create(TodayEntrySchema, {
					epoch: BigInt(entry.epoch),
					active: entry.active,
					sealed: entry.sealed,
					target: entry.target,
					reason: entry.reason,
					lossWindowMs:
						entry.lossWindowMs === undefined
							? undefined
							: BigInt(entry.lossWindowMs),
					decidedAtMs: BigInt(entry.decidedAtMs),
					decidedBy: entry.decidedBy,
				}),
			),
		}),
	);
}

/** Today's decodeAssignmentLog: refuses a format other than 1 and any unknown field. */
export function decodeTodayLog(value: string): TodayEntry[] {
	let log: TodayWireLog;
	try {
		log = fromJsonString(TodayLogSchema, value);
	} catch {
		throw new Error("stored assignment log does not parse");
	}
	if (log.format !== LOG_FORMAT)
		throw new Error("stored assignment log has an unknown format");
	const entries = log.entries.map((entry) => ({
		epoch: Number(entry.epoch),
		active: entry.active,
		sealed: entry.sealed,
		target: entry.target,
		reason: entry.reason,
		lossWindowMs:
			entry.lossWindowMs === undefined ? undefined : Number(entry.lossWindowMs),
		decidedAtMs: Number(entry.decidedAtMs),
		decidedBy: entry.decidedBy,
	}));
	for (let index = 1; index < entries.length; index += 1)
		if (entries[index]?.epoch !== (entries[index - 1]?.epoch ?? 0) + 1)
			throw new Error("stored assignment log is not contiguous");
	return entries;
}
