import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createContainerStallGuard,
	DEFAULT_HOST_PRESSURE_ADMISSION_THRESHOLDS,
	hostCpuAdmitFits,
	hostCpuHeadroomCpus,
	hostMemoryAdmitFits,
	hostPressureBlocksAdmission,
	leaseCpuLoadAccountedInLoad1,
	parsePsiAverages,
	pendingTrunkCpuReservationCpus,
	readHostResourcePressureSample,
	trunkWorkerCpuHeadroomFields,
} from "../src/isolated-worker/host-resource-pressure.js";

describe("host resource pressure", () => {
	it("parses PSI avg10 lines", () => {
		const text = `some avg10=1.50 avg60=0.80 avg300=0.40 total=100\nfull avg10=25.00 avg60=12.00 avg300=6.00 total=90\n`;
		expect(parsePsiAverages(text)).toEqual({
			someAvg10: 1.5,
			fullAvg10: 25,
		});
	});

	it("blocks admission on elevated memory PSI even when MemAvailable looks adequate", () => {
		const sample = {
			atMs: 0,
			availableMb: 5_500,
			memoryPsi: { someAvg10: 30, fullAvg10: 20 },
		};
		expect(hostPressureBlocksAdmission(sample)).toBe(true);
		expect(hostMemoryAdmitFits(5_500, 2_048, 2_048, 1_024, sample)).toBe(false);
	});

	it("requires volatility margin on MemAvailable headroom", () => {
		expect(hostMemoryAdmitFits(4_500, 1_024, 2_048, 1_024)).toBe(true);
		expect(hostMemoryAdmitFits(4_000, 1_024, 2_048, 1_024)).toBe(false);
	});

	it("blocks CPU admission when load plus reserved trunk jobs exhaust cores", () => {
		const input = {
			cores: 4,
			load1: 0.5,
			reservedCpus: 4,
			volatilityCpus: 1,
			requestCpus: 4,
		};
		expect(hostCpuHeadroomCpus(input)).toBe(-1.5);
		expect(hostCpuAdmitFits(input)).toBe(false);
		expect(trunkWorkerCpuHeadroomFields(input)).toMatchObject({
			cpuCores: 4,
			cpuHeadroom: -1.5,
		});
	});

	it("admits another trunk job when headroom covers request plus volatility", () => {
		expect(
			hostCpuAdmitFits({
				cores: 8,
				load1: 2,
				reservedCpus: 4,
				volatilityCpus: 1,
				requestCpus: 4,
			}),
		).toBe(false);
		expect(
			hostCpuAdmitFits({
				cores: 8,
				load1: 1,
				reservedCpus: 0,
				volatilityCpus: 1,
				requestCpus: 4,
			}),
		).toBe(true);
	});

	it("regression: eight cores load 1.6 with running standards does not double-count reservations", () => {
		const leases = [
			{ memoryMb: 4_096, state: "running", sandboxStage: "running" },
			{ memoryMb: 4_096, state: "running", sandboxStage: "running" },
		];
		expect(pendingTrunkCpuReservationCpus(leases, 4_096, 4)).toBe(0);
		expect(leaseCpuLoadAccountedInLoad1(leases[0])).toBe(true);
		expect(
			hostCpuAdmitFits({
				cores: 8,
				load1: 1.6,
				reservedCpus: pendingTrunkCpuReservationCpus(leases, 4_096, 4),
				volatilityCpus: 1,
				requestCpus: 4,
				runningTrunkJobs: 2,
			}),
		).toBe(true);
		const threeRunning = [
			...leases,
			{ memoryMb: 4_096, state: "running", sandboxStage: "running" },
		];
		expect(
			hostCpuAdmitFits({
				cores: 8,
				load1: 1.6,
				reservedCpus: pendingTrunkCpuReservationCpus(threeRunning, 4_096, 4),
				volatilityCpus: 1,
				requestCpus: 4,
				runningTrunkJobs: 3,
			}),
		).toBe(true);
		expect(
			pendingTrunkCpuReservationCpus(
				[
					{ memoryMb: 4_096, state: "running", sandboxStage: "running" },
					{ memoryMb: 4_096, state: "reserved" },
				],
				4_096,
				4,
			),
		).toBe(0);
	});

	it("regression: one running container at load 1.9 admits another main shard (run 43152192203)", () => {
		const running = {
			memoryMb: 4_096,
			state: "running",
			sandboxStage: "running",
		};
		const memoryHeld = [
			{ memoryMb: 4_096, state: "reserved" },
			{ memoryMb: 4_096, state: "reserved" },
			{ memoryMb: 4_096, state: "reserved" },
		];
		const leases = [running, ...memoryHeld];
		expect(pendingTrunkCpuReservationCpus(leases, 4_096, 4)).toBe(0);
		expect(
			hostCpuAdmitFits({
				cores: 8,
				load1: 1.9,
				reservedCpus: pendingTrunkCpuReservationCpus(leases, 4_096, 4),
				volatilityCpus: 1,
				requestCpus: 4,
				runningTrunkJobs: 1,
			}),
		).toBe(true);
		expect(
			hostCpuHeadroomCpus({
				cores: 8,
				load1: 1.9,
				reservedCpus: 0,
				volatilityCpus: 1,
				requestCpus: 4,
			}),
		).toBeCloseTo(5.1, 5);
	});

	it("does not block when PSI is below admission thresholds", () => {
		const sample = {
			atMs: 0,
			availableMb: 6_000,
			memoryPsi: { someAvg10: 1, fullAvg10: 5 },
			cpuPsi: { someAvg10: 2, fullAvg10: 10 },
		};
		expect(
			hostPressureBlocksAdmission(
				sample,
				DEFAULT_HOST_PRESSURE_ADMISSION_THRESHOLDS,
			),
		).toBe(false);
	});

	it("reads meminfo-derived swap and availability from fixture", () => {
		const meminfo = [
			"MemAvailable:       4718592 kB",
			"SwapTotal:       8388608 kB",
			"SwapFree:        7340032 kB",
		].join("\n");
		const dir = mkdtempSync(join(tmpdir(), "hobo-meminfo-"));
		const path = join(dir, "meminfo");
		writeFileSync(path, meminfo);
		const sample = readHostResourcePressureSample(1, { meminfo: path });
		rmSync(dir, { recursive: true, force: true });
		expect(sample.availableMb).toBe(4_608);
		expect(sample.swapTotalMb).toBe(8_192);
		expect(sample.swapUsedMb).toBe(1_024);
	});

	it("requires consecutive stall samples before signalling requeue", () => {
		let reads = 0;
		const guard = createContainerStallGuard({
			thresholds: {
				memoryPsiFullStall: 10,
				cpuPsiFullStall: 100,
				loadPerCpuStall: 10,
				swapDeltaMbStall: 1_000,
				consecutiveSamples: 2,
			},
			read: () => {
				reads += 1;
				return {
					atMs: reads,
					memoryPsi: { someAvg10: 50, fullAvg10: 50 },
				};
			},
		});
		expect(guard.evaluate("lease-a")).toBeUndefined();
		expect(guard.evaluate("lease-a")?.reason).toBe("memory-psi");
	});
});
