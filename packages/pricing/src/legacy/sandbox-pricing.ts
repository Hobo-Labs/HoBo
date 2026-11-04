import { create } from "@bufbuild/protobuf";
import {
	type SandboxAllowance,
	SandboxAllowanceSchema,
	type SandboxPricing,
} from "../_generated/legacy_ci_pb.js";

const fields = [
	"cpuVcpuMs",
	"memoryMbMs",
	"egressBytes",
	"creations",
	"proxyBytes",
	"proxySessions",
	"proxyControlCalls",
] as const;
interface Units {
	cpuVcpuMs: bigint;
	memoryMbMs: bigint;
	egressBytes: bigint;
	creations: bigint;
	proxyBytes: bigint;
	proxySessions: bigint;
	proxyControlCalls: bigint;
}
function integer(value: number, name: string, min = 0): bigint {
	if (!Number.isSafeInteger(value) || value < min)
		throw new Error(`invalid sandbox ${name}`);
	return BigInt(value);
}
function cost(numerator: bigint, denominator: bigint): bigint {
	return (numerator + denominator - 1n) / denominator;
}
function safeNumber(value: bigint): number {
	if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error("unsafe sandbox quantity or charge");
	return Number(value);
}
function units(value?: SandboxAllowance) {
	return {
		cpuVcpuMs: integer(value?.cpuVcpuMs ?? 0, "CPU allowance"),
		memoryMbMs: integer(value?.memoryMbMs ?? 0, "memory allowance"),
		egressBytes: integer(value?.egressBytes ?? 0, "egress allowance"),
		creations: integer(value?.creations ?? 0, "creation allowance"),
		proxyBytes: integer(value?.proxyBytes ?? 0, "proxy allowance"),
		proxySessions: integer(
			value?.proxySessions ?? 0,
			"proxy-session allowance",
		),
		proxyControlCalls: integer(
			value?.proxyControlCalls ?? 0,
			"proxy-control allowance",
		),
	};
}
function message(value: Units): SandboxAllowance {
	return create(SandboxAllowanceSchema, {
		cpuVcpuMs: safeNumber(value.cpuVcpuMs),
		memoryMbMs: safeNumber(value.memoryMbMs),
		egressBytes: safeNumber(value.egressBytes),
		creations: safeNumber(value.creations),
		proxyBytes: safeNumber(value.proxyBytes),
		proxySessions: safeNumber(value.proxySessions),
		proxyControlCalls: safeNumber(value.proxyControlCalls),
	});
}
function subtractFloor(total: Units, used: readonly SandboxAllowance[]) {
	const out = { ...total };
	for (const usage of used) {
		const part = units(usage);
		for (const field of fields)
			out[field] = out[field] > part[field] ? out[field] - part[field] : 0n;
	}
	return out;
}
function take(requested: Units, available: Units) {
	const result = { ...requested };
	for (const field of fields)
		result[field] =
			requested[field] < available[field] ? requested[field] : available[field];
	return result;
}
/** Rates and optional remaining free units come from an explicitly trusted, current publisher. */
export function validateSandboxPricing(pricing: SandboxPricing): void {
	const cpus = integer(pricing.vcpus, "vcpus", 1);
	if (cpus > 32n || (cpus !== 1n && cpus % 2n !== 0n))
		throw new Error("invalid sandbox vcpus");
	const memory = integer(pricing.memoryMb, "memory", 1);
	if (memory < cpus * 2048n)
		throw new Error("sandbox memory quote below provisioned minimum");
	integer(pricing.cpuMicrosPerVcpuHour, "CPU rate", 1);
	integer(pricing.memoryMicrosPerGbHour, "memory rate", 1);
	integer(pricing.creationMicros, "creation price", 1);
	integer(pricing.egressMicrosPerGb, "egress rate", 1);
	integer(pricing.proxyMicrosPerGb, "proxy rate", 1);
	integer(pricing.proxyFixedMicros, "proxy fixed price", 1);
	integer(pricing.bootstrapFixedMicros, "bootstrap fixed price", 1);
	const max = integer(pricing.maxEgressBytes, "egress quota", 1);
	const headroom = integer(pricing.networkHeadroomBytes, "network headroom", 1);
	if (max + headroom > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error("unsafe sandbox network reservation");
	if (pricing.proxyVmRequired) {
		const proxyCpus = integer(pricing.proxyVmVcpus, "proxy vcpus", 1);
		const planCap =
			pricing.plan === "hobby"
				? 4n
				: pricing.plan === "pro"
					? 8n
					: pricing.plan === "enterprise"
						? 32n
						: 0n;
		if (cpus > planCap || proxyCpus > planCap)
			throw new Error("sandbox resources exceed plan limits");
		if (proxyCpus > 32n || (proxyCpus !== 1n && proxyCpus % 2n !== 0n))
			throw new Error("invalid proxy vcpus");
		if (integer(pricing.proxyVmMemoryMb, "proxy memory", 1) < proxyCpus * 2048n)
			throw new Error("proxy memory quote below provisioned minimum");
		integer(pricing.proxyVmExtraMs, "proxy lifecycle margin", 1);
		const proxyNetwork = integer(
			pricing.proxyVmNetworkBytes,
			"proxy network budget",
			1,
		);
		const proxyHeadroom = integer(
			pricing.proxyVmNetworkHeadroomBytes,
			"proxy network headroom",
			1,
		);
		if (
			proxyNetwork < max * 2n ||
			proxyNetwork + proxyHeadroom > BigInt(Number.MAX_SAFE_INTEGER)
		)
			throw new Error("unsafe proxy network reservation");
		if (
			!/^(iad1|sfo1|cle1|cdg1|fra1|arn1|sin1|pdx1|lhr1|icn1|bom1|cpt1|dub1|gru1|hkg1|syd1|yul1|hnd1|kix1)$/.test(
				pricing.region,
			)
		)
			throw new Error("sandbox region required");
		integer(pricing.proxyControlMaxCalls, "proxy control call budget", 1);
		integer(pricing.proxyControlCallMicros, "proxy control call rate", 1);
	} else if (
		pricing.proxyVmVcpus ||
		pricing.proxyVmMemoryMb ||
		pricing.proxyVmExtraMs ||
		pricing.proxyVmNetworkBytes ||
		pricing.proxyVmNetworkHeadroomBytes ||
		pricing.proxyControlMaxCalls ||
		pricing.proxyControlCallMicros
	) {
		throw new Error("proxy VM configuration requires proxy VM");
	}
}
export function validateSandboxAllowance(allowance: SandboxAllowance): void {
	units(allowance);
}
function total(
	pricing: SandboxPricing,
	requested: Units,
	free: Units,
	hostMicros: bigint,
	includeRunnerBootstrap = true,
): number {
	return safeNumber(
		cost(
			(requested.cpuVcpuMs - free.cpuVcpuMs) *
				BigInt(pricing.cpuMicrosPerVcpuHour),
			3_600_000n,
		) +
			cost(
				(requested.memoryMbMs - free.memoryMbMs) *
					BigInt(pricing.memoryMicrosPerGbHour),
				3_600_000_000n,
			) +
			(requested.creations - free.creations) * BigInt(pricing.creationMicros) +
			cost(
				(requested.egressBytes - free.egressBytes) *
					BigInt(pricing.egressMicrosPerGb),
				1_000_000_000n,
			) +
			cost(
				(requested.proxyBytes - free.proxyBytes) *
					BigInt(pricing.proxyMicrosPerGb),
				1_000_000_000n,
			) +
			(requested.proxySessions - free.proxySessions) *
				BigInt(pricing.proxyFixedMicros) +
			(includeRunnerBootstrap ? BigInt(pricing.bootstrapFixedMicros) : 0n) +
			(requested.proxyControlCalls - free.proxyControlCalls) *
				BigInt(pricing.proxyControlCallMicros) +
			hostMicros,
	);
}
/** Conservative reservation over all resource dimensions. Shared free snapshots are
 * reduced by every active reservation and every completed usage since observation.
 * Network headroom is an estimate; billed network may exceed the reservation. */
export function sandboxReservationQuote(
	pricing: SandboxPricing,
	minutes: number,
	hostMicrosPerMinute: number,
	allowance?: SandboxAllowance,
	consumed: readonly SandboxAllowance[] = [],
) {
	validateSandboxPricing(pricing);
	const durationMs = integer(minutes, "minutes", 1) * 60_000n;
	const host = integer(hostMicrosPerMinute, "host rate");
	const max = BigInt(pricing.maxEgressBytes);
	const proxyDuration = pricing.proxyVmRequired
		? durationMs + BigInt(pricing.proxyVmExtraMs)
		: 0n;
	if (
		pricing.proxyVmRequired &&
		proxyDuration > (pricing.plan === "hobby" ? 2_700_000n : 86_400_000n)
	)
		throw new Error("sandbox duration exceeds plan limit");
	const requested = {
		cpuVcpuMs:
			durationMs * BigInt(pricing.vcpus) +
			proxyDuration * BigInt(pricing.proxyVmVcpus),
		memoryMbMs:
			BigInt(pricing.memoryMb) * durationMs +
			BigInt(pricing.proxyVmMemoryMb) * proxyDuration,
		egressBytes:
			max +
			BigInt(pricing.networkHeadroomBytes) +
			BigInt(pricing.proxyVmNetworkBytes) +
			BigInt(pricing.proxyVmNetworkHeadroomBytes),
		creations: pricing.proxyVmRequired ? 2n : 1n,
		proxyBytes: max,
		proxySessions: 1n,
		proxyControlCalls: BigInt(pricing.proxyControlMaxCalls),
	} satisfies Units;
	const reserved = take(requested, subtractFloor(units(allowance), consumed));
	return {
		paidMicros: total(pricing, requested, reserved, BigInt(minutes) * host),
		reservedAllowance: message(reserved),
	};
}
export function sandboxReservationMicros(
	pricing: SandboxPricing,
	minutes: number,
	hostMicrosPerMinute: number,
): number {
	return sandboxReservationQuote(pricing, minutes, hostMicrosPerMinute)
		.paidMicros;
}
/** The consumed free units never exceed the units previously reserved for this lease. */
export function sandboxUsageQuote(
	pricing: SandboxPricing,
	usage: {
		cpuVcpuMs: number;
		memoryMb: number;
		durationMs: number;
		egressBytes: number;
		proxyBytes: number;
		hostMicros: number;
		proxyControlCalls?: number;
		proxyVm?: {
			cpuVcpuMs: number;
			memoryMb: number;
			durationMs: number;
			ingressBytes: number;
			egressBytes: number;
		};
	},
	reserved?: SandboxAllowance,
) {
	validateSandboxPricing(pricing);
	if (
		pricing.proxyVmRequired &&
		(!usage.proxyVm || usage.proxyControlCalls === undefined)
	)
		throw new Error("verified proxy VM usage and control calls required");
	if (!pricing.proxyVmRequired && (usage.proxyVm || usage.proxyControlCalls))
		throw new Error("unexpected proxy VM usage");
	const duration = integer(usage.durationMs, "duration");
	const proxy = usage.proxyVm;
	const proxyDuration = proxy
		? integer(proxy.durationMs, "proxy duration")
		: 0n;
	const requested = {
		cpuVcpuMs:
			integer(usage.cpuVcpuMs, "CPU usage") +
			(proxy ? integer(proxy.cpuVcpuMs, "proxy CPU usage") : 0n),
		memoryMbMs:
			integer(usage.memoryMb, "memory usage", 1) *
				(duration < 60_000n ? 60_000n : duration) +
			(proxy
				? integer(proxy.memoryMb, "proxy memory usage", 1) *
					(proxyDuration < 60_000n ? 60_000n : proxyDuration)
				: 0n),
		egressBytes:
			integer(usage.egressBytes, "egress usage") +
			(proxy
				? integer(proxy.egressBytes, "proxy egress usage") +
					integer(proxy.ingressBytes, "proxy ingress usage")
				: 0n),
		creations: proxy ? 2n : 1n,
		proxyBytes: integer(usage.proxyBytes, "proxy usage"),
		proxySessions: 1n,
		proxyControlCalls: integer(
			usage.proxyControlCalls ?? 0,
			"proxy control calls",
		),
	} satisfies Units;
	const used = take(requested, units(reserved));
	return {
		paidMicros: total(
			pricing,
			requested,
			used,
			integer(usage.hostMicros, "host charge"),
		),
		usedAllowance: message(used),
	};
}
/** Settle the proxy alone only after the caller proves guest creation never began. */
export function sandboxProxyOnlyUsageQuote(
	pricing: SandboxPricing,
	usage: {
		proxyVm: {
			cpuVcpuMs: number;
			memoryMb: number;
			durationMs: number;
			ingressBytes: number;
			egressBytes: number;
		};
		proxyBytes: number;
		proxyControlCalls: number;
		hostMicros: number;
	},
	reserved?: SandboxAllowance,
) {
	validateSandboxPricing(pricing);
	if (!pricing.proxyVmRequired)
		throw new Error("proxy VM configuration required");
	const duration = integer(usage.proxyVm.durationMs, "proxy duration");
	const requested = {
		cpuVcpuMs: integer(usage.proxyVm.cpuVcpuMs, "proxy CPU usage"),
		memoryMbMs:
			integer(usage.proxyVm.memoryMb, "proxy memory usage", 1) *
			(duration < 60_000n ? 60_000n : duration),
		egressBytes:
			integer(usage.proxyVm.ingressBytes, "proxy ingress usage") +
			integer(usage.proxyVm.egressBytes, "proxy egress usage"),
		creations: 1n,
		proxyBytes: integer(usage.proxyBytes, "proxy usage"),
		proxySessions: 1n,
		proxyControlCalls: integer(usage.proxyControlCalls, "proxy control calls"),
	} satisfies Units;
	const used = take(requested, units(reserved));
	return {
		paidMicros: total(
			pricing,
			requested,
			used,
			integer(usage.hostMicros, "host charge"),
			false,
		),
		usedAllowance: message(used),
	};
}
export function sandboxUsageMicros(
	pricing: SandboxPricing,
	usage: Parameters<typeof sandboxUsageQuote>[1],
): number {
	return sandboxUsageQuote(pricing, usage).paidMicros;
}
