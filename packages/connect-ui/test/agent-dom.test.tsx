// @vitest-environment jsdom
import { JSONUIProvider, Renderer } from "@json-render/react";
import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { agentPressAllowed } from "../src/client/agent-gate.js";
import { confirmLabelsForSpec } from "../src/client/confirm-labels.js";
import { registry } from "../src/client/connect-registry.js";
import {
	ConnectFormParamsBridge,
	ConnectRuntimeProvider,
} from "../src/client/connect-runtime.js";
import { type ConnectStep, deterministicConnectSpec } from "../src/index.js";

const APP_STEP: ConnectStep = {
	kind: "create-github-app",
	provider: "github",
	appName: "HoBo CI",
	owner: "octo-org",
	store: "infisical",
};

function Harness({ step }: { readonly step: ConnectStep }) {
	const spec = deterministicConnectSpec(step);
	const confirmByAction = new Map([
		["connect.start", "Open GitHub to register the App?"],
	]);
	const confirmByLabel = confirmLabelsForSpec(spec, confirmByAction);
	const collector = useRef<(includeSecrets: boolean) => Record<string, string>>(
		() => ({}),
	);
	const secretNames = new Set<string>();
	return (
		<ConnectRuntimeProvider
			confirmByLabel={confirmByLabel}
			collector={collector}
		>
			<JSONUIProvider registry={registry} initialState={{}} handlers={{}}>
				<ConnectFormParamsBridge
					secretNames={secretNames}
					collector={collector}
				/>
				<Renderer spec={spec} registry={registry} />
			</JSONUIProvider>
		</ConnectRuntimeProvider>
	);
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("connect page agent DOM contract", () => {
	it("exposes data-agent-confirm on the GitHub hand-off control", () => {
		render(<Harness step={APP_STEP} />);
		const button = screen.getByRole("button", { name: "Continue on GitHub" });
		const host = button.closest("[data-agent-confirm]");
		expect(host?.getAttribute("data-agent-confirm")).toMatch(/GitHub/u);
	});

	it("blocks agent press simulation until the person approves the confirm text", () => {
		render(<Harness step={APP_STEP} />);
		const message = screen
			.getByRole("button", { name: "Continue on GitHub" })
			.closest("[data-agent-confirm]")
			?.getAttribute("data-agent-confirm");
		expect(agentPressAllowed(message ?? undefined, false)).toBe(false);
		expect(agentPressAllowed(message ?? undefined, true)).toBe(true);
	});
});
