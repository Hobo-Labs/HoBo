import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createContainerStallGuard,
	DEFAULT_HOST_PRESSURE_ADMISSION_THRESHOLDS,
	hostMemoryAdmitFits,
	hostPressureBlocksAdmission,
	parsePsiAverages,
	readHostResourcePressureSample,
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
		expect(
			hostMemoryAdmitFits(5_500, 2_048, 2_048, 1_024, sample),
		).toBe(false);
	});

	it("requires volatility margin on MemAvailable headroom", () => {
		expect(hostMemoryAdmitFits(4_500, 1_024, 2_048, 1_024)).toBe(true);
		expect(hostMemoryAdmitFits(4_000, 1_024, 2_048, 1_024)).toBe(false);
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
