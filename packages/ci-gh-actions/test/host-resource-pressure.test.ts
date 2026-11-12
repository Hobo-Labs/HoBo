import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	cpuShareNotYetInLoad1,
	createContainerStallGuard,
	DEFAULT_HOST_PRESSURE_ADMISSION_THRESHOLDS,
	hostCpuAdmitFits,
	hostCpuHeadroomCpus,
	hostMemoryAdmitFits,
	hostPressureBlocksAdmission,
	leaseCpuLoadAccountedInLoad1,
	memoryShareNotYetResident,
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

	it("blocks admission on CPU `some` pressure, since the host never reports `full`", () => {
		// /proc/pressure/cpu on a saturated host: the kernel prints full as zero.
		const saturated = parsePsiAverages(
			"some avg10=71.20 avg60=64.02 avg300=40.11 total=1447842\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
		);
		expect(saturated).toEqual({ someAvg10: 71.2, fullAvg10: 0 });
		expect(hostPressureBlocksAdmission({ atMs: 1, cpuPsi: saturated })).toBe(
			true,
		);
		expect(
			hostPressureBlocksAdmission({
				atMs: 1,
				cpuPsi: { someAvg10: 20, fullAvg10: 0 },
			}),
		).toBe(false);
	});

	it("subtracts promised memory from what the host shows free", () => {
		expect(hostMemoryAdmitFits(7_500, 4_096, 2_048, 1_024)).toBe(true);
		expect(
			hostMemoryAdmitFits(
				7_500,
				4_096,
				2_048,
				1_024,
				undefined,
				undefined,
				512,
			),
		).toBe(false);
	});

	it("follows the load average's lag for a started job's CPU", () => {
		const now = Date.parse("2026-11-12T11:52:35.000Z");
		const at = (agoMs: number) => new Date(now - agoMs).toISOString();
		expect(cpuShareNotYetInLoad1(at(0), now)).toBe(1);
		expect(cpuShareNotYetInLoad1(at(60_000), now)).toBeCloseTo(0.368, 3);
		expect(cpuShareNotYetInLoad1(at(180_000), now)).toBe(0);
		// No start time: the job is taken as already in the average.
		expect(cpuShareNotYetInLoad1(undefined, now)).toBe(0);
		expect(cpuShareNotYetInLoad1("", now)).toBe(0);
	});

	it("lets a started job's memory hold fall away over the ramp", () => {
		const now = Date.parse("2026-11-12T11:52:35.000Z");
		const at = (agoMs: number) => new Date(now - agoMs).toISOString();
		expect(memoryShareNotYetResident(at(0), now, 120_000)).toBe(1);
		expect(memoryShareNotYetResident(at(30_000), now, 120_000)).toBe(0.75);
		expect(memoryShareNotYetResident(at(200_000), now, 120_000)).toBe(0);
		expect(memoryShareNotYetResident(at(0), now, 0)).toBe(0);
		expect(memoryShareNotYetResident(undefined, now, 120_000)).toBe(0);
	});
});
