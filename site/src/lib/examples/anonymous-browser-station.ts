export type AnonymousStationInput = {
	readonly stationId: string;
	readonly targetId: string;
	readonly yardId: string;
	readonly label: string;
	readonly capabilities: readonly string[];
};

export type AnonymousStationHost = {
	readonly endpointUrl: string;
	revoke(): void;
};

export function createAnonymousBrowserStation(
	input: AnonymousStationInput,
): AnonymousStationHost {
	const config = JSON.stringify({
		ok: true,
		kind: "hobo-environment-station",
		anonymous: true,
		stationId: input.stationId,
		targetId: input.targetId,
		yardId: input.yardId,
		label: input.label,
		capabilities: input.capabilities,
		provisionedAt: new Date().toISOString(),
	});
	const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(input.label)} · HoBo Environment Station</title>
  <meta name="robots" content="noindex">
</head>
<body data-hobo-station="${escapeHtml(input.targetId)}" data-anonymous="true">
  <h1>HoBo Environment Station</h1>
  <p>${escapeHtml(input.label)} · anonymous operator bootstrap</p>
  <p>No Bindle / app code on this station yet. Ship places apps after capability match.</p>
  <pre id="station">${escapeHtml(config)}</pre>
  <script>
    window.parent?.postMessage(
      { source: "hobo-environment-station", status: "ready", stationId: ${JSON.stringify(input.stationId)} },
      "*",
    );
  </script>
</body>
</html>`;
	const endpointUrl = URL.createObjectURL(
		new Blob([html], { type: "text/html;charset=utf-8" }),
	);
	return {
		endpointUrl,
		revoke: () => URL.revokeObjectURL(endpointUrl),
	};
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
