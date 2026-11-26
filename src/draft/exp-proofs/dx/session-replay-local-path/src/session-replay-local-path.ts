/**
 * DX journey: record → store → summarize → evidence pack under dual fixtures.
 */
import {
	buildEvidencePack,
	createReplayService,
	webReplayAutowire,
	evaluateRecordingPolicy,
} from "@hobo/replay";

export type LocalPathProof = Readonly<{
	ok: boolean;
	sessionId: string;
	summary: string;
	killSwitchWorks: boolean;
	autowireLocalDefault: boolean;
	evidenceSchema: string;
	openUiKind: string;
}>;

export async function proveLocalReplayPath(): Promise<LocalPathProof> {
	const service = createReplayService({
		stationId: "station:local",
		memory: true,
	});
	const tracker = service.startRecording({
		sessionId: "sess-dx-1",
		seedEvents: [
			{
				type: 2,
				timestamp: 100,
				data: {
					tagName: "input",
					type: "password",
					attributes: { type: "password" },
					value: "hunter2",
				},
			},
			{ type: 3, timestamp: 200, data: { source: 2, text: "click" } },
		],
	});
	await tracker.linkError("err-dx-1", "evt-cp-1");
	tracker.noteFlagExposure("hobo.session-replay");
	await tracker.flush();
	const ended = await tracker.stop();
	const summary = (await service.summarize(tracker.sessionId)) ?? "";
	const opened = await service.open(tracker.sessionId);

	const kill = evaluateRecordingPolicy({ env: { HOBO_REPLAY: "0" } });
	const wire = webReplayAutowire();
	const pack = buildEvidencePack({
		session: ended!,
		recording: [
			{ type: 2, timestamp: 100, data: { tagName: "div" } },
		],
		playwrightRefs: ["playwright-trace.zip"],
		assertionLog: ["password masked", "error linked", "flag correlated"],
		screenshots: [
			{
				name: "player-open.png",
				sha256:
					"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			},
		],
	});

	return Object.freeze({
		ok:
			ended?.status === "ended" &&
			summary.includes("err-dx-1") &&
			opened.ok === true &&
			!JSON.stringify(ended).includes("hunter2"),
		sessionId: tracker.sessionId,
		summary,
		killSwitchWorks: kill.enabled === false,
		autowireLocalDefault: wire.bindleFeature.localDefault === true,
		evidenceSchema: pack.schemaVersion,
		openUiKind:
			opened.ok && opened.payload.openUi.kind
				? opened.payload.openUi.kind
				: "none",
	});
}
