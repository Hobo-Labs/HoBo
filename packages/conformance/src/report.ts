import {
	type ConformanceRunEvent,
	type PortSuiteReport,
	REPORT_SCHEMA,
} from "./types.js";

export function projectPortSuiteReport(
	events: readonly ConformanceRunEvent[],
): PortSuiteReport {
	const started = events.find(
		(event) => event.type === "conformance.RunStarted",
	);
	const completed = events.find(
		(event) => event.type === "conformance.RunCompleted",
	);
	const coverageEvent = events.find(
		(event) => event.type === "conformance.CoverageEvaluated",
	);

	if (!started || !completed || !coverageEvent) {
		throw new TypeError("conformance run event log is incomplete");
	}

	const caseEvents = events.filter(
		(event) => event.type === "conformance.CaseChecked",
	);
	const assertions = caseEvents.flatMap((event) => event.assertions);
	const caseFailures = caseEvents.flatMap((event) => event.failures);
	const failures = [...caseFailures, ...coverageEvent.failures];
	const failureCodes = completed.failureCodes;

	return {
		schema: REPORT_SCHEMA,
		ok: completed.ok,
		suiteId: started.suiteId,
		port: started.port,
		adapterId: started.adapterId,
		seed: started.seed,
		provenance: {
			suiteId: started.suiteId,
			port: started.port,
			adapterId: started.adapterId,
			seed: started.seed,
			cases: [...started.caseIds],
		},
		claim: {
			status: completed.ok ? "listed" : "blocked",
			port: started.port,
			adapterId: started.adapterId,
			failureCodes,
		},
		assertions,
		coverage: coverageEvent.coverage,
		failures,
		events: [...events],
	};
}

export function replayPortSuiteReport(
	report: PortSuiteReport,
): PortSuiteReport {
	return projectPortSuiteReport(report.events);
}
