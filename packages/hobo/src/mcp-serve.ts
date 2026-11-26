import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileSettingsStore } from "@hobo/connect-ui";
import { createTrustedVault } from "@hobo/core";
import type { DeviceClock } from "@hobo/hobo-cd";
import {
	agentVaultProxyLauncher,
	applyEgressToProcess,
	ensureInfisicalAgentVaultCli,
	hoboToolsDir,
	isOwnerStoreSetting,
	machineRunner,
	OwnerStoreOperationUncertainError,
	scopeRunVault,
	secretStoreLocatorPath,
	whichOnPath,
} from "@hobo/hobo-ci";
import { createHoboMcpServer } from "@hobo/mcp";
import type { AgentVaultProxyDeps } from "./agent-vault-broker.js";
import { ownerSecretStoreBindingStore } from "./ci-secret-store.js";
import { createComposedHoboCli, ownerForFamily } from "./cli.js";
import {
	relaunchInputFor,
	relaunchMcpUnderOpenSesame,
	reportingCredentialRefusals,
	wantsOpenSesameRelaunch,
} from "./credentials-opensesame.js";
import {
	createMcpOwnerChannel,
	createOwnerCaptureApp,
} from "./mcp-owner-channel.js";
import { createOwnerPages } from "./mcp-owner-page.js";
import { createRelayLoginTool } from "./mcp-relay-login.js";
import {
	createInfisicalCaptureConnector,
	secretCaptureProjectDir,
} from "./mcp-secret-capture.js";
import {
	createMcpStdioSession,
	localOperatorAuth,
	type McpStdioSession,
	serveMcpStdio,
} from "./mcp-stdio.js";
import { createStoreChoiceApp } from "./mcp-store-choice.js";
import { removeOwnedDirsOnSignals } from "./owned-temp-dir.js";
import {
	createOwnerStoreSessions,
	type OwnerSignIn,
	ownerChannelRelayFolder,
	ownerChannelSignIn,
	withRelaySession,
} from "./owner-store-session.js";
import {
	OwnerWriteGuardUnavailableError,
	ownerWriteGuard,
} from "./owner-write-guard.js";
import {
	createRelayOwnerSessions,
	type RelayLoginDeps,
} from "./relay-owner-session.js";

interface OwnerWriteRoot {
	active: boolean;
	readonly nonce: string;
	readonly pending: Set<Promise<unknown>>;
	uncertain: boolean;
}

interface OwnerWriteFrame {
	active: boolean;
	readonly root: OwnerWriteRoot;
}

interface OwnerWriteContext {
	readonly scopes: ReadonlyMap<string, OwnerWriteFrame>;
	readonly current: OwnerWriteFrame;
}

interface OwnerWriteAttempt {
	started: boolean;
}

type OwnerWritePreparation<T> = () => Promise<
	{ readonly completed: true; readonly result: T } | undefined
>;

function waitForWriteTurn(
	previous: Promise<void>,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const cancel = () => {
			signal.removeEventListener("abort", cancel);
			reject(
				new Error("The owner session changed. Start this operation again."),
			);
		};
		if (signal.aborted) return cancel();
		signal.addEventListener("abort", cancel, { once: true });
		void previous.then(
			() => {
				signal.removeEventListener("abort", cancel);
				resolve();
			},
			() => {
				signal.removeEventListener("abort", cancel);
				reject(new Error("The owner write queue could not be entered."));
			},
		);
	});
}

function waitForReadOnlyPreparation<T>(
	preparation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	return new Promise((resolve, reject) => {
		const cancel = () => {
			signal.removeEventListener("abort", cancel);
			reject(
				new Error("The owner session changed. Start this operation again."),
			);
		};
		void preparation
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", cancel));
		if (signal.aborted) cancel();
		else signal.addEventListener("abort", cancel, { once: true });
	});
}

/**
 * The full `hobo-mcp` server, loaded by `bin/hobo-mcp.ts` once it has
 * answered the host's `initialize` (see mcp-handshake.ts).
 */

/**
 * The HoBo MCP server's parts, wired once for the binary and its evals: the
 * owner channel, whose every step is a form in the owner's host asked in the
 * call that needs it; the composed CLI on that channel; the secret capture
 * and store choice apps; and the session they share.
 */
export function composeHoboMcp(options: {
	/** Where the server writes (its notifications go here too). */
	readonly output: NodeJS.WritableStream;
	/** Where the capture connector keeps its non-secret state. */
	readonly projectDir: string;
	/** The owner is not at this machine (a remote dev box). */
	readonly remote: boolean;
	/** The device grant's clock (evals pass a virtual one). */
	readonly clock?: DeviceClock;
	readonly ownerWriteGuardFor?: typeof ownerWriteGuard;
	readonly ownerSignIn?: OwnerSignIn;
	readonly agentVault?: AgentVaultProxyDeps;
	readonly relayLogin?: Partial<RelayLoginDeps> & { readonly waitMs?: number };
}) {
	// The owner's channel: what they hand over through the capture form waits
	// here, in memory, for the ceremony run through this server.
	// The session exists once the transport starts; prompts go through it.
	let session: McpStdioSession | undefined;
	let capture: ReturnType<typeof createOwnerCaptureApp> | undefined;
	const guardFor = options.ownerWriteGuardFor ?? ownerWriteGuard;
	const forms = () =>
		session?.support.formElicitation === true && options.remote
			? session
			: undefined;
	const canonical = (cwd: string) => {
		const absolute = path.resolve(cwd);
		try {
			return realpathSync(absolute);
		} catch {
			return absolute;
		}
	};
	const scopeForProject = (family: "ci" | "cd", project: string) =>
		`${family}\u0000${project}`;
	const scope = (family: "ci" | "cd", cwd: string) =>
		scopeForProject(family, canonical(cwd));
	const sameOwnerSettings = (
		left: Readonly<Record<string, string>>,
		right: Readonly<Record<string, string>>,
	) => {
		const leftNames = Object.keys(left).filter(isOwnerStoreSetting);
		const rightNames = Object.keys(right).filter(isOwnerStoreSetting);
		return (
			leftNames.length === rightNames.length &&
			leftNames.every((name) => left[name] === right[name])
		);
	};
	const sessionSettings = new Map<string, Readonly<Record<string, string>>>();
	const sessionChoices = new Set<string>();
	const generations = new Map<string, number>();
	const sharedGenerations = new Map<string, string>();
	const unfencedScopes = new Set<string>();
	const selectionRequiredScopes = new Set<string>();
	const selectionControllers = new Map<string, AbortController>();
	const pendingWrites = new Map<string, number>();
	const writeQueues = new Map<string, Promise<void>>();
	const runningWrites = new Set<string>();
	const writeScope = new AsyncLocalStorage<OwnerWriteContext>();
	const isWriting = (key: string) => {
		const context = writeScope.getStore();
		const frame = context?.scopes.get(key);
		return (
			context?.current.active === true &&
			context.current.root.active &&
			frame?.root.active === true
		);
	};
	const uncertainWrites = new Set<string>();
	const ownSecretChanges = new Map<string, number>();
	const familyVaults = new Map<string, ReturnType<typeof createTrustedVault>>();
	let invalidateStoreSession: (cwd: string) => void = () => {};
	let closed = false;
	const scopeGeneration = (family: "ci" | "cd", project: string) => {
		const key = scopeForProject(family, project);
		let selected: ReturnType<
			ReturnType<typeof ownerWriteGuard>["currentSelection"]
		>;
		try {
			selected = guardFor(key, project).currentSelection();
		} catch (error) {
			if (!(error instanceof OwnerWriteGuardUnavailableError)) throw error;
			unfencedScopes.add(key);
			return undefined;
		}
		const actual = selected.generation;
		const previous = sharedGenerations.get(key);
		const wasUnfenced = unfencedScopes.delete(key);
		if (previous === undefined && !wasUnfenced) {
			sharedGenerations.set(key, actual);
			if (selected.requiresChoice && !sessionChoices.has(key))
				selectionRequiredScopes.add(key);
			return actual;
		}
		if (previous !== actual || wasUnfenced) {
			sharedGenerations.set(key, actual);
			selectionRequiredScopes.add(key);
			sessionSettings.delete(key);
			sessionChoices.delete(key);
			familyVaults.get(key)?.clear();
			familyVaults.delete(key);
			invalidateStoreSession(project);
			selectionControllers.get(key)?.abort();
			selectionControllers.delete(key);
			owner.cancelScopeKey(key);
			generations.set(key, (generations.get(key) ?? 0) + 1);
			throw new Error("The owner session changed. Start this operation again.");
		}
		return actual;
	};
	const storeSettingsFor = (
		family: "ci" | "cd",
		cwd: string,
		project = canonical(cwd),
	) => {
		const key = scopeForProject(family, project);
		const guard = guardFor(key, project);
		const sharedGeneration = closed
			? undefined
			: scopeGeneration(family, project);
		const generation = generations.get(key) ?? 0;
		let invalidated = false;
		let controller = selectionControllers.get(key);
		if (!controller) {
			controller = new AbortController();
			if (closed) controller.abort();
			else selectionControllers.set(key, controller);
		}
		const assertPathCurrent = () => {
			let matches = false;
			try {
				matches =
					realpathSync(path.resolve(cwd)) === project &&
					realpathSync(project) === project;
			} catch {}
			if (invalidated || !matches) {
				if (!invalidated) {
					invalidated = true;
					if (runningWrites.has(key)) uncertainWrites.add(key);
					selectionRequiredScopes.add(key);
					sessionSettings.delete(key);
					sessionChoices.delete(key);
					familyVaults.get(key)?.clear();
					familyVaults.delete(key);
					invalidateStoreSession(project);
					controller.abort();
					selectionControllers.delete(key);
					owner.cancelScopeKey(key);
					generations.set(key, (generations.get(key) ?? 0) + 1);
				}
				throw new Error(
					"The owner session changed. Start this operation again.",
				);
			}
		};
		const assertGeneration = () => {
			if (closed || (generations.get(key) ?? 0) !== generation)
				throw new Error(
					"The owner session changed. Start this operation again.",
				);
		};
		const assertCurrent = () => {
			assertGeneration();
			assertPathCurrent();
			if (uncertainWrites.has(key))
				throw new OwnerStoreOperationUncertainError();
			const actual = scopeGeneration(family, project);
			if (
				actual !== undefined &&
				!isWriting(key) &&
				(pendingWrites.get(key) ?? 0) === 0
			) {
				try {
					guard.assertClear();
				} catch (error) {
					if (!(error instanceof OwnerWriteGuardUnavailableError)) throw error;
					unfencedScopes.add(key);
				}
			}
		};
		const runScopedWrite = async <T>(
			write: () => Promise<T>,
			prepare?: OwnerWritePreparation<T>,
			validateBeforeDispatch?: () => true,
			attempt?: OwnerWriteAttempt,
		): Promise<T> => {
			const scope = writeScope.getStore();
			const assertInheritedScopes = () => {
				if (scope && (!scope.current.active || !scope.current.root.active))
					throw new Error("The owner write scope has closed.");
				for (const frame of scope?.scopes.values() ?? []) {
					if (!frame.root.active)
						throw new Error("The owner write scope has closed.");
					if (frame.root.uncertain)
						throw new OwnerStoreOperationUncertainError();
				}
			};
			assertInheritedScopes();
			const inherited = scope?.scopes.get(key);
			assertCurrent();
			validateBeforeDispatch?.();
			if (inherited) {
				const frame: OwnerWriteFrame = { active: true, root: inherited.root };
				const nested = (async () => {
					let started = false;
					try {
						const prepared = await prepare?.();
						assertInheritedScopes();
						assertCurrent();
						if (!frame.root.active || frame.root.uncertain)
							throw new OwnerStoreOperationUncertainError();
						validateBeforeDispatch?.();
						if (prepared?.completed) return prepared.result;
						started = true;
						if (attempt) attempt.started = true;
						const result = await writeScope.run(
							{
								scopes: new Map([...(scope?.scopes ?? []), [key, frame]]),
								current: frame,
							},
							write,
						);
						assertInheritedScopes();
						assertCurrent();
						return result;
					} catch (error) {
						if (started) frame.root.uncertain = true;
						throw error;
					} finally {
						frame.active = false;
					}
				})();
				frame.root.pending.add(nested);
				void nested.then(
					() => frame.root.pending.delete(nested),
					() => frame.root.pending.delete(nested),
				);
				return nested;
			}
			if (selectionRequiredScopes.has(key))
				throw new Error(
					"Choose the secret store through the owner form before writing.",
				);
			if (sharedGeneration === undefined || unfencedScopes.has(key))
				throw new OwnerWriteGuardUnavailableError();
			const previous = writeQueues.get(key) ?? Promise.resolve();
			let release: () => void = () => undefined;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const queued = previous.then(() => held);
			writeQueues.set(key, queued);
			pendingWrites.set(key, (pendingWrites.get(key) ?? 0) + 1);
			try {
				await waitForWriteTurn(previous, controller.signal);
				assertCurrent();
				if (unfencedScopes.has(key))
					throw new OwnerWriteGuardUnavailableError();
				const snapshot = prepare
					? guard.currentPreparationSnapshot(sharedGeneration)
					: undefined;
				let prepared:
					| { readonly completed: true; readonly result: T }
					| undefined;
				try {
					prepared = prepare
						? await waitForReadOnlyPreparation(prepare(), controller.signal)
						: undefined;
				} catch (error) {
					if (uncertainWrites.has(key))
						throw new OwnerStoreOperationUncertainError();
					throw error;
				}
				assertCurrent();
				assertInheritedScopes();
				if (prepared?.completed) {
					const current = guard.currentPreparationSnapshot(sharedGeneration);
					if (
						!snapshot ||
						current.settingsRevision !== snapshot.settingsRevision ||
						current.operationRevision !== snapshot.operationRevision
					)
						throw new Error(
							"The owner session changed. Start this operation again.",
						);
					return prepared.result;
				}
				let activeRoot: OwnerWriteRoot | undefined;
				return await guard.run(
					async (nonce) => {
						const root: OwnerWriteRoot = {
							active: true,
							nonce,
							pending: new Set(),
							uncertain: false,
						};
						activeRoot = root;
						const context: OwnerWriteFrame = { active: true, root };
						runningWrites.add(key);
						try {
							let outcome:
								| { readonly ok: true; readonly value: T }
								| { readonly ok: false; readonly error: unknown };
							try {
								if (attempt) attempt.started = true;
								outcome = {
									ok: true,
									value: await writeScope.run(
										{
											scopes: new Map([
												...(scope?.scopes ?? []),
												[key, context],
											]),
											current: context,
										},
										write,
									),
								};
							} catch (error) {
								outcome = { ok: false, error };
							} finally {
								context.active = false;
							}
							while (root.pending.size > 0)
								await waitForWriteTurn(
									Promise.allSettled(root.pending).then(() => undefined),
									controller.signal,
								);
							if (root.uncertain) throw new OwnerStoreOperationUncertainError();
							if (!outcome.ok) throw outcome.error;
							assertInheritedScopes();
							assertGeneration();
							assertPathCurrent();
							return outcome.value;
						} finally {
							runningWrites.delete(key);
							context.active = false;
							root.active = false;
						}
					},
					() =>
						closed ||
						uncertainWrites.has(key) ||
						activeRoot?.uncertain === true,
					sharedGeneration,
					() => {
						assertInheritedScopes();
						assertCurrent();
						if (unfencedScopes.has(key))
							throw new OwnerWriteGuardUnavailableError();
						validateBeforeDispatch?.();
						return true;
					},
					() => uncertainWrites.has(key),
					snapshot,
				);
			} finally {
				release();
				void queued.then(() => {
					if (writeQueues.get(key) === queued) writeQueues.delete(key);
				});
				const remaining = (pendingWrites.get(key) ?? 1) - 1;
				if (remaining > 0) pendingWrites.set(key, remaining);
				else pendingWrites.delete(key);
			}
		};
		const observe = <T>(
			operation: Promise<T>,
			attempt: OwnerWriteAttempt,
		): Promise<T> => {
			const scope = writeScope.getStore();
			if (scope?.current.active && scope.current.root.active) {
				const roots = new Set(
					[...scope.scopes.values()].map((frame) => frame.root),
				);
				for (const root of roots) {
					if (!root.active) continue;
					root.pending.add(operation);
					void operation.then(
						() => root.pending.delete(operation),
						() => {
							if (attempt.started) root.uncertain = true;
							root.pending.delete(operation);
						},
					);
				}
			}
			void operation.catch(() => undefined);
			return operation;
		};
		const launch = <T>(
			write: () => Promise<T>,
			prepare?: OwnerWritePreparation<T>,
			validateBeforeDispatch?: () => true,
		): Promise<T> => {
			const attempt: OwnerWriteAttempt = { started: false };
			const scope = writeScope.getStore();
			let operation: Promise<T>;
			if (scope?.current.active && scope.current.root.active) {
				const frame: OwnerWriteFrame = {
					active: true,
					root: scope.current.root,
				};
				operation = writeScope.run(
					{ scopes: scope.scopes, current: frame },
					() => runScopedWrite(write, prepare, validateBeforeDispatch, attempt),
				);
				void operation.then(
					() => {
						frame.active = false;
					},
					() => {
						frame.active = false;
					},
				);
			} else {
				operation = runScopedWrite(
					write,
					prepare,
					validateBeforeDispatch,
					attempt,
				);
			}
			return observe(operation, attempt);
		};
		return {
			assertCurrent,
			selectionSignal: controller.signal,
			hasPendingWrites: () => (pendingWrites.get(key) ?? 0) > 0,
			requiresOwnerChoice: () => selectionRequiredScopes.has(key),
			selectionRevision: () => {
				assertCurrent();
				if ((pendingWrites.get(key) ?? 0) > 0 && !isWriting(key))
					throw new Error("The selected store is saving a change.");
				if (sharedGeneration === undefined || unfencedScopes.has(key))
					throw new OwnerWriteGuardUnavailableError();
				return guard.currentSettingsRevision();
			},
			locatorRevision: () => {
				assertCurrent();
				if ((pendingWrites.get(key) ?? 0) > 0 && !isWriting(key))
					throw new Error("The selected store is saving a change.");
				if (sharedGeneration === undefined || unfencedScopes.has(key))
					throw new OwnerWriteGuardUnavailableError();
				const current = guard.currentSettingsRevision();
				const ownChanges = ownSecretChanges.get(key) ?? 0;
				if (ownChanges > current) throw new OwnerWriteGuardUnavailableError();
				return current - ownChanges;
			},
			canReuseOwnerProof: () => false,
			hasExclusiveMutationAuthority: () => false,
			recordStoreChange: () => {
				assertCurrent();
				const current = writeScope.getStore()?.scopes.get(key);
				if (!current || !isWriting(key))
					throw new Error("No active owner store write.");
				if (current.root.uncertain)
					throw new OwnerStoreOperationUncertainError();
				if (sharedGeneration === undefined || unfencedScopes.has(key))
					throw new OwnerWriteGuardUnavailableError();
				const revision = guard.advanceSettingsRevision(
					sharedGeneration,
					current.root.nonce,
				);
				const ownChanges = ownSecretChanges.get(key) ?? 0;
				if (ownChanges >= revision) throw new OwnerWriteGuardUnavailableError();
				ownSecretChanges.set(key, ownChanges + 1);
			},
			markUncertainWrite: () => {
				uncertainWrites.add(key);
				if (!isWriting(key)) guard.markUncertain();
			},
			runStoreWrite: <T>(
				write: () => Promise<T>,
				validateBeforeDispatch?: () => true,
			) => launch(write, undefined, validateBeforeDispatch),
			runPreparedStoreWrite: <P, T>(
				prepareReadOnly: () => Promise<
					import("@hobo/hobo-ci").PreparedStoreWrite<P, T>
				>,
				write: (prepared: P) => Promise<T>,
			): Promise<T> => {
				let value: P;
				return launch(
					() => write(value),
					async () => {
						const prepared = await prepareReadOnly();
						if (prepared.kind === "completed")
							return { completed: true, result: prepared.result } as const;
						value = prepared.value;
					},
				);
			},
			hasSessionChoice: () => sessionChoices.has(key),
			onOwnerChoice: () => {
				assertCurrent();
				if ((pendingWrites.get(key) ?? 0) > 0)
					throw new Error("The selected store is saving a change.");
				if (sharedGeneration === undefined || unfencedScopes.has(key))
					throw new OwnerWriteGuardUnavailableError();
				let next: string;
				try {
					next = guard.changeGeneration(sharedGeneration);
				} catch (error) {
					scopeGeneration(family, project);
					throw error;
				}
				sharedGenerations.set(key, next);
				selectionRequiredScopes.delete(key);
				familyVaults.get(key)?.clear();
				familyVaults.delete(key);
				invalidateStoreSession(project);
				controller.abort();
				selectionControllers.delete(key);
				owner.cancelScopeKey(key);
				sessionChoices.add(key);
				generations.set(key, generation + 1);
			},
			read: async () => {
				if (closed) return {};
				assertCurrent();
				const values =
					sessionSettings.get(key) ??
					(await fileSettingsStore(secretStoreLocatorPath(project)).read());
				assertCurrent();
				return selectionRequiredScopes.has(key)
					? Object.fromEntries(
							Object.entries(values).filter(
								([name]) => !isOwnerStoreSetting(name),
							),
						)
					: values;
			},
			write: async (values: Readonly<Record<string, string>>) => {
				assertCurrent();
				if (selectionRequiredScopes.has(key))
					throw new Error(
						"Choose the secret store through the owner form before writing.",
					);
				const previous =
					sessionSettings.get(key) ??
					(await fileSettingsStore(secretStoreLocatorPath(project)).read());
				assertCurrent();
				const current = sessionSettings.get(key) ?? previous;
				if (!sameOwnerSettings(current, values)) {
					if ((pendingWrites.get(key) ?? 0) > 0 && !isWriting(key))
						throw new Error("The selected store is saving a change.");
					if (sharedGeneration === undefined || unfencedScopes.has(key))
						throw new OwnerWriteGuardUnavailableError();
					const currentWrite = writeScope.getStore()?.scopes.get(key);
					guard.advanceSettingsRevision(
						sharedGeneration,
						currentWrite && isWriting(key)
							? currentWrite.root.nonce
							: undefined,
					);
				}
				sessionSettings.set(key, { ...values });
			},
		};
	};
	const vaultForProject = (family: "ci" | "cd", project: string) => {
		if (closed) throw new Error("The owner session is closed.");
		const key = scopeForProject(family, project);
		scopeGeneration(family, project);
		let vault = familyVaults.get(key);
		if (!vault) {
			vault = scopeRunVault(createTrustedVault());
			familyVaults.set(key, vault);
		}
		return vault;
	};
	const owner = createMcpOwnerChannel({
		storeSettingsFor,
		scopeKey: scope,
		requireScope: true,
		vaultFor: (family, cwd) => vaultForProject(family, canonical(cwd)),
		bindScope: (family, cwd) => {
			const project = canonical(cwd);
			const settings = storeSettingsFor(family, cwd, project);
			const vault = vaultForProject(family, project);
			settings.assertCurrent();
			return {
				key: scopeForProject(family, project),
				vault,
				storeSettings: settings,
			};
		},
		// Every step that needs the owner is a form in their host, asked in
		// the call that needs it: nothing is relayed through the agent.
		form: (params) =>
			forms()?.request?.("elicitation/create", params) ?? undefined,
		canConfirm: () => forms()?.request !== undefined,
		ask: async (name) => {
			const host = forms();
			if (host === undefined || capture === undefined) return false;
			const outcome = await capture.callTool(
				"capture_secret",
				{ name },
				{ ...host.support, apps: false },
			);
			return outcome.kind === "result" && outcome.result.isError !== true;
		},
		notify: (method, params) => {
			options.output.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		},
	});
	const sessions = createOwnerStoreSessions({
		signIn:
			options.ownerSignIn ??
			((input) =>
				ownerChannelSignIn({
					owner:
						ownerForFamily(owner, input.family ?? "cd", input.cwd) ?? owner,
					deps: {
						runCommand: machineRunner(),
						which: (bin) => whichOnPath(bin),
					},
				})(input)),
		relayFolder: (input) =>
			ownerChannelRelayFolder({
				owner: ownerForFamily(owner, "ci", input.cwd) ?? owner,
				deps: {
					runCommand: machineRunner(),
					which: (bin) => whichOnPath(bin),
				},
			})(input),
		keptFor: (cwd, family) => vaultForProject(family, canonical(cwd)),
		agentVault: options.agentVault ?? {
			launch: agentVaultProxyLauncher(),
			command: () =>
				ensureInfisicalAgentVaultCli({
					run: machineRunner(),
					which: (bin) => whichOnPath(bin),
					toolsDir: hoboToolsDir(),
				}),
		},
	});
	invalidateStoreSession = (cwd) => sessions.invalidate?.(cwd);
	const sleep =
		options.relayLogin?.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = options.relayLogin?.now ?? Date.now;
	const relay = createRelayOwnerSessions({
		fetch: options.relayLogin?.fetch ?? fetch,
		sleep,
		now,
	});
	const ownerSession = withRelaySession(sessions, {
		held: () => relay.held(),
		now,
	});
	const pages = createOwnerPages();
	const server = createHoboMcpServer({
		cli: createComposedHoboCli({
			ownerChannel: owner,
			ownerSession,
			...(options.clock !== undefined ? { clock: options.clock } : undefined),
		}),
	});
	// The secret-capture MCP App (ADR-0179 amendment "Deploy secrets captured
	// by an MCP App into the secret store"): values the owner types go from
	// the form to this process to the store the relay's binding names, and
	// never into a tool result. URL elicitation completion is the one
	// notification this server sends.
	capture = createOwnerCaptureApp({
		owner,
		remote: options.remote,
		elicit: (params) => {
			const request = session?.request;
			if (request === undefined)
				return Promise.reject(new Error("the transport is not connected"));
			return request("elicitation/create", params);
		},
		connector: createInfisicalCaptureConnector({
			bindingStore: ownerSecretStoreBindingStore(
				sessions.entries(options.projectDir),
			),
		}),
		notify: (method, params) => {
			options.output.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		},
	});
	session = createMcpStdioSession(
		capture,
		createStoreChoiceApp({
			locatorFor: (cwd, family) => storeSettingsFor(family, cwd),
			sessions,
			pages,
			relayLogin: createRelayLoginTool({
				relay,
				pages,
				sleep,
				...(options.relayLogin?.waitMs !== undefined
					? { waitMs: options.relayLogin.waitMs }
					: undefined),
			}),
		}),
	);
	const ready = capture;
	return {
		owner,
		server,
		session,
		sessions,
		relay,
		/** Stop whatever still waits on the owner and close open captures. */
		async close() {
			closed = true;
			sessionSettings.clear();
			sessionChoices.clear();
			generations.clear();
			sharedGenerations.clear();
			unfencedScopes.clear();
			selectionRequiredScopes.clear();
			for (const controller of selectionControllers.values())
				controller.abort();
			selectionControllers.clear();
			pendingWrites.clear();
			writeQueues.clear();
			for (const vault of familyVaults.values()) vault.clear();
			familyVaults.clear();
			owner.vault?.clear();
			owner.close();
			owner.jobs.close();
			relay.close();
			await sessions.close();
			await ready.close();
		},
	};
}

// The runnable MCP control surface: the composed
// hobo CLI (default LOCAL/MOCKED lane; live lanes stay credential-gated by
// env) exposed over MCP stdio. Every tool call dispatches through the same
// command registry as the `hobo` binary — one surface, two transports.
export async function serveHoboMcp(
	io: {
		readonly input: NodeJS.ReadableStream;
		readonly output: NodeJS.WritableStream;
	} = { input: process.stdin, output: process.stdout },
): Promise<number> {
	// The default runtime's throwaway event store is removed on exit; as the
	// entry point, this process has it removed on a signal too.
	removeOwnedDirsOnSignals();
	// The box's egress (proxy, bypass list, CA), for every fetch in this
	// process, before anything connects.
	applyEgressToProcess(process.env);
	const composed = composeHoboMcp({
		output: io.output,
		projectDir: secretCaptureProjectDir(process.cwd(), process.env),
		remote: true,
	});
	try {
		await serveMcpStdio({
			server: composed.server,
			auth: localOperatorAuth(),
			input: io.input,
			output: io.output,
			session: composed.session,
		});
	} finally {
		// Closes open captures, stops the page and revokes the writer token,
		// and stops any step still waiting on the owner.
		await composed.close();
	}
	return 0;
}

// HOBO_CREDENTIALS=opensesame (ADR-0170): its tools run the same verbs as
// `hobo`, `up` among them, so it relaunches under OpenSesame as `hobo` does,
// stdin and stdout passing through to the relaunched server; it needs
// OPENSESAME_STORE_PASSWORD for that (credentials-opensesame.ts says why). A
// credential refusal when the server is composed is one `hobo:` line and 1.
export async function runHoboMcp(): Promise<number> {
	return wantsOpenSesameRelaunch(process.env)
		? await relaunchMcpUnderOpenSesame(relaunchInputFor(process))
		: await reportingCredentialRefusals(serveHoboMcp);
}

/** The full server on the given streams, reporting a credential refusal as `hobo:` and 1. */
export function serveHoboMcpOn(io: {
	readonly input: NodeJS.ReadableStream;
	readonly output: NodeJS.WritableStream;
}): Promise<number> {
	return reportingCredentialRefusals(() => serveHoboMcp(io));
}
