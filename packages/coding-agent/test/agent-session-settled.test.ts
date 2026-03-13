import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentMessage } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, getModel, type UserMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const wait = async (ms: number): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

const createDeferred = (): { promise: Promise<void>; resolve: () => void } => {
	let resolve!: () => void;
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
};

const createAssistantMessage = (stopReason: "aborted" | "error"): AssistantMessage => {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		errorMessage: stopReason === "error" ? "forced test error" : undefined,
		timestamp: Date.now(),
	};
};

const createUserMessage = (text: string): UserMessage => {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
};

const createTestResourceLoader = () => {
	return {
		getExtensions: () => ({
			extensions: [],
			errors: [],
			runtime: {
				sendMessage: () => {
					throw new Error("Extension runtime not initialized");
				},
				sendUserMessage: () => {
					throw new Error("Extension runtime not initialized");
				},
				appendEntry: () => {
					throw new Error("Extension runtime not initialized");
				},
				setSessionName: () => {
					throw new Error("Extension runtime not initialized");
				},
				getSessionName: () => {
					throw new Error("Extension runtime not initialized");
				},
				setLabel: () => {
					throw new Error("Extension runtime not initialized");
				},
				getActiveTools: () => {
					throw new Error("Extension runtime not initialized");
				},
				getAllTools: () => {
					throw new Error("Extension runtime not initialized");
				},
				setActiveTools: () => {
					throw new Error("Extension runtime not initialized");
				},
				refreshTools: () => {
					throw new Error("Extension runtime not initialized");
				},
				registerProvider: () => {
					throw new Error("Extension runtime not initialized");
				},
				unregisterProvider: () => {
					throw new Error("Extension runtime not initialized");
				},
				getCommands: () => {
					throw new Error("Extension runtime not initialized");
				},
				setModel: () => {
					return Promise.reject(new Error("Extension runtime not initialized"));
				},
				getThinkingLevel: () => {
					throw new Error("Extension runtime not initialized");
				},
				setThinkingLevel: () => {
					throw new Error("Extension runtime not initialized");
				},
				flagValues: new Map(),
				pendingProviderRegistrations: [],
			},
		}),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};
};

type AgentSettledEvent = Extract<AgentSessionEvent, { type: "agent_settled" }>;

interface AgentSessionTestInternals {
	_handleAgentEvent: (event: AgentEvent) => void;
	_agentEventQueue: Promise<void>;
	_emitExtensionEvent: (event: AgentEvent) => Promise<void>;
	_scheduleAgentContinue: (delayMs?: number) => void;
	_cancelReservedTurnRequest: () => Promise<void>;
	_settlementState: {
		pendingTurnRequests: number;
	};
	_settlementEpoch: number;
	_settledDispatchPromise: Promise<void> | undefined;
	_activeSettledMutationWindow:
		| {
				settlementEpoch: number;
				requestVersion: number;
				mutationToken?: symbol;
		  }
		| undefined;
	_extensionRunner:
		| {
				hasHandlers: (eventType: string) => boolean;
				emit: (event: AgentSettledEvent) => Promise<void>;
		  }
		| undefined;
}

const getInternals = (session: AgentSession): AgentSessionTestInternals => {
	return session as unknown as AgentSessionTestInternals;
};

const emitAgentEvent = async (session: AgentSession, event: AgentEvent): Promise<void> => {
	const internals = getInternals(session);
	internals._handleAgentEvent(event);
	await internals._agentEventQueue;
};

const isAgentSettledEvent = (event: AgentSessionEvent): event is AgentSettledEvent => {
	return event.type === "agent_settled";
};

describe("AgentSession agent_settled", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agent-settled-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(() => {
		session.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	it("emits agent_settled after agent_end when no follow-on work remains", async () => {
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			events.push(event);
		});

		await emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});

		const settledEvents = events.filter(isAgentSettledEvent);
		expect(settledEvents).toHaveLength(1);
		expect(settledEvents[0]?.messages).toHaveLength(1);
	});

	it("reports isSettled inside agent_settled listeners", async () => {
		const observedSettledStates: boolean[] = [];
		session.subscribe((event) => {
			if (event.type === "agent_settled") {
				observedSettledStates.push(session.isSettled);
			}
		});

		await emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});

		expect(observedSettledStates).toEqual([true]);
	});

	it("does not settle while a follow-on prompt is still in preflight during agent_end", async () => {
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			events.push(event);
		});

		const originalGetApiKey = session.modelRegistry.getApiKey.bind(session.modelRegistry);
		const releasePreflight = createDeferred();
		(
			session.modelRegistry as unknown as {
				getApiKey: (model: Parameters<ModelRegistry["getApiKey"]>[0]) => Promise<string | undefined>;
			}
		).getApiKey = async () => {
			await releasePreflight.promise;
			return undefined;
		};

		let followOnError: Error | undefined;
		const internals = getInternals(session);
		internals._emitExtensionEvent = async (event: AgentEvent) => {
			if (event.type === "agent_end") {
				void session.prompt("follow-on prompt").catch((error: unknown) => {
					followOnError = error instanceof Error ? error : new Error(String(error));
				});
				await wait(20);
				expect(session.isSettled).toBe(false);
			}
		};

		const agentEndPromise = emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});

		await wait(40);
		expect(events.filter(isAgentSettledEvent)).toHaveLength(0);

		releasePreflight.resolve();
		await agentEndPromise;
		await session.waitForSettled({ timeoutMs: 500 });

		expect(followOnError?.message).toContain("No API key found for anthropic");
		expect(events.filter(isAgentSettledEvent)).toHaveLength(1);
		expect(events.filter(isAgentSettledEvent)[0]?.messages[0]).toMatchObject({ stopReason: "aborted" });
		(
			session.modelRegistry as unknown as {
				getApiKey: (model: Parameters<ModelRegistry["getApiKey"]>[0]) => Promise<string | undefined>;
			}
		).getApiKey = originalGetApiKey;
	});

	it("does not settle an earlier run when agent_end schedules a successful follow-on turn", async () => {
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			events.push(event);
		});

		const originalPrompt = session.agent.prompt.bind(session.agent);
		let promptCalls = 0;
		const internals = getInternals(session);
		(session.agent as unknown as { prompt: (message: AgentMessage | AgentMessage[]) => Promise<void> }).prompt =
			async () => {
				promptCalls++;
				internals._handleAgentEvent({ type: "agent_start" });
				(session.agent.state as { isStreaming: boolean }).isStreaming = true;
			};

		internals._emitExtensionEvent = async (event: AgentEvent) => {
			if (event.type === "agent_end" && promptCalls === 0) {
				await session.prompt("follow-on prompt");
				(session.agent.state as { isStreaming: boolean }).isStreaming = false;
				setTimeout(() => {
					internals._handleAgentEvent({
						type: "agent_end",
						messages: [createAssistantMessage("error")],
					});
				}, 0);
			}
		};

		await emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});
		await session.waitForSettled({ timeoutMs: 500 });

		const settledEvents = events.filter(isAgentSettledEvent);
		expect(settledEvents).toHaveLength(1);
		expect(settledEvents[0]?.messages[0]).toMatchObject({ stopReason: "error" });
		(session.agent as unknown as { prompt: (message: AgentMessage | AgentMessage[]) => Promise<void> }).prompt =
			originalPrompt;
	});

	it("re-settles when a follow-on prompt request fails during agent_end", async () => {
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			events.push(event);
		});

		const originalPrompt = session.agent.prompt.bind(session.agent);
		(session.agent as unknown as { prompt: (message: AgentMessage | AgentMessage[]) => Promise<void> }).prompt =
			async () => {
				throw new Error("prompt failed");
			};

		const internals = getInternals(session);
		internals._emitExtensionEvent = async (event: AgentEvent) => {
			if (event.type === "agent_end") {
				await expect(session.prompt("follow-on prompt")).rejects.toThrow("prompt failed");
			}
		};

		await emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});
		await session.waitForSettled({ timeoutMs: 500 });

		const settledEvents = events.filter(isAgentSettledEvent);
		expect(settledEvents).toHaveLength(1);
		expect(settledEvents[0]?.messages[0]).toMatchObject({ stopReason: "aborted" });
		(session.agent as unknown as { prompt: (message: AgentMessage | AgentMessage[]) => Promise<void> }).prompt =
			originalPrompt;
	});

	it("re-settles when triggerTurn custom-message requests fail during agent_end", async () => {
		const events: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			events.push(event);
		});

		const originalPrompt = session.agent.prompt.bind(session.agent);
		(session.agent as unknown as { prompt: (message: AgentMessage | AgentMessage[]) => Promise<void> }).prompt =
			async () => {
				throw new Error("custom prompt failed");
			};

		const internals = getInternals(session);
		internals._emitExtensionEvent = async (event: AgentEvent) => {
			if (event.type === "agent_end") {
				await expect(
					session.sendCustomMessage({ customType: "test", content: "x", display: true }, { triggerTurn: true }),
				).rejects.toThrow("custom prompt failed");
			}
		};

		await emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});
		await session.waitForSettled({ timeoutMs: 500 });

		expect(events.filter(isAgentSettledEvent)).toHaveLength(1);
		(session.agent as unknown as { prompt: (message: AgentMessage | AgentMessage[]) => Promise<void> }).prompt =
			originalPrompt;
	});

	it("waitForSettled stays blocked while agent_end is queued behind earlier work", async () => {
		const internals = getInternals(session);
		let agentEndStarted = false;

		internals._emitExtensionEvent = async (event: AgentEvent) => {
			if (event.type === "message_end") {
				await wait(60);
			}
			if (event.type === "agent_end") {
				agentEndStarted = true;
			}
		};

		internals._handleAgentEvent({
			type: "message_end",
			message: createUserMessage("queued earlier work"),
		});
		internals._handleAgentEvent({
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});
		await wait(10);

		let waitResolved = false;
		const waitPromise = session.waitForSettled({ timeoutMs: 500 }).then(() => {
			waitResolved = true;
		});

		await wait(20);
		expect(agentEndStarted).toBe(false);
		expect(waitResolved).toBe(false);

		await internals._agentEventQueue;
		await waitPromise;
		expect(agentEndStarted).toBe(true);
	});

	it("waitForSettled stays blocked until agent_settled handlers finish", async () => {
		const settledHandlerStarted = createDeferred();
		const releaseSettledHandler = createDeferred();
		let handlerCompleted = false;

		getInternals(session)._extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "agent_settled",
			emit: async () => {
				settledHandlerStarted.resolve();
				await releaseSettledHandler.promise;
				handlerCompleted = true;
			},
		};

		const internals = getInternals(session);
		internals._handleAgentEvent({
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});
		await settledHandlerStarted.promise;

		let waitResolved = false;
		const waitPromise = session.waitForSettled({ timeoutMs: 500 }).then(() => {
			waitResolved = true;
		});

		await wait(20);
		expect(handlerCompleted).toBe(false);
		expect(waitResolved).toBe(false);

		releaseSettledHandler.resolve();
		await internals._agentEventQueue;
		await waitPromise;
		expect(handlerCompleted).toBe(true);
	});

	it("queued steer during streaming does not leak pending turn requests", async () => {
		(session.agent.state as { isStreaming: boolean }).isStreaming = true;

		await session.steer("queued steer");
		expect(getInternals(session)._settlementState.pendingTurnRequests).toBe(0);

		(session.agent.state as { isStreaming: boolean }).isStreaming = false;
		session.agent.clearAllQueues();
		await expect(session.waitForSettled({ timeoutMs: 200 })).resolves.toBeUndefined();
	});

	it("queued follow-up during streaming does not leak pending turn requests", async () => {
		(session.agent.state as { isStreaming: boolean }).isStreaming = true;

		await session.followUp("queued follow-up");
		expect(getInternals(session)._settlementState.pendingTurnRequests).toBe(0);

		(session.agent.state as { isStreaming: boolean }).isStreaming = false;
		session.agent.clearAllQueues();
		await expect(session.waitForSettled({ timeoutMs: 200 })).resolves.toBeUndefined();
	});

	it("streaming prompt queueing does not leak pending turn requests", async () => {
		(session.agent.state as { isStreaming: boolean }).isStreaming = true;

		await session.prompt("queued prompt", { streamingBehavior: "followUp" });
		expect(getInternals(session)._settlementState.pendingTurnRequests).toBe(0);

		(session.agent.state as { isStreaming: boolean }).isStreaming = false;
		session.agent.clearAllQueues();
		await expect(session.waitForSettled({ timeoutMs: 200 })).resolves.toBeUndefined();
	});

	it("streaming custom-message queueing does not leak pending turn requests", async () => {
		(session.agent.state as { isStreaming: boolean }).isStreaming = true;

		await session.sendCustomMessage({ customType: "test", content: "queued custom", display: true });
		expect(getInternals(session)._settlementState.pendingTurnRequests).toBe(0);

		(session.agent.state as { isStreaming: boolean }).isStreaming = false;
		session.agent.clearAllQueues();
		await expect(session.waitForSettled({ timeoutMs: 200 })).resolves.toBeUndefined();
	});

	it("waitForSettled resolves when a scheduled internal continue fails", async () => {
		const originalContinue = session.agent.continue.bind(session.agent);
		(session.agent as unknown as { continue: () => Promise<void> }).continue = async () => {
			throw new Error("continue failed");
		};

		getInternals(session)._scheduleAgentContinue(0);
		await emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});

		await expect(session.waitForSettled({ timeoutMs: 500 })).resolves.toBeUndefined();
		(session.agent as unknown as { continue: () => Promise<void> }).continue = originalContinue;
	});

	it("scheduled internal continue does not reserve a turn request when continue starts streaming", async () => {
		const originalContinue = session.agent.continue.bind(session.agent);
		const releaseContinue = createDeferred();
		(session.agent as unknown as { continue: () => Promise<void> }).continue = async () => {
			(session.agent.state as { isStreaming: boolean }).isStreaming = true;
			await releaseContinue.promise;
			(session.agent.state as { isStreaming: boolean }).isStreaming = false;
		};

		getInternals(session)._scheduleAgentContinue(0);
		await wait(20);
		expect(getInternals(session)._settlementState.pendingTurnRequests).toBe(0);

		releaseContinue.resolve();
		await session.waitForSettled({ timeoutMs: 500 });
		(session.agent as unknown as { continue: () => Promise<void> }).continue = originalContinue;
	});

	it("throws when cancelling a turn request that was never reserved", async () => {
		await expect(getInternals(session)._cancelReservedTurnRequest()).rejects.toThrow(
			"AgentSession settlement counter underflow: pendingTurnRequests",
		);
	});

	it("fork waits for unsettled preflight work before mutating the session tree", async () => {
		session.sessionManager.appendMessage(createUserMessage("fork me"));
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		const entryId = session.sessionManager.getEntries()[0]?.id;
		expect(entryId).toBeDefined();

		const originalSessionId = session.sessionId;
		const releasePreflight = createDeferred();
		const originalGetApiKey = session.modelRegistry.getApiKey.bind(session.modelRegistry);
		(
			session.modelRegistry as unknown as {
				getApiKey: (model: Parameters<ModelRegistry["getApiKey"]>[0]) => Promise<string | undefined>;
			}
		).getApiKey = async () => {
			await releasePreflight.promise;
			return undefined;
		};

		const promptPromise = session.prompt("blocked prompt").catch(() => {});
		let forkResolved = false;
		const forkPromise = session.fork(entryId!).then((result) => {
			forkResolved = true;
			return result;
		});

		await wait(20);
		expect(forkResolved).toBe(false);
		expect(session.sessionId).toBe(originalSessionId);

		releasePreflight.resolve();
		await promptPromise;
		const forkResult = await forkPromise;
		expect(forkResult.cancelled).toBe(false);
		expect(session.sessionId).not.toBe(originalSessionId);
		(
			session.modelRegistry as unknown as {
				getApiKey: (model: Parameters<ModelRegistry["getApiKey"]>[0]) => Promise<string | undefined>;
			}
		).getApiKey = originalGetApiKey;
	});

	it("navigateTree waits for unsettled preflight work before changing the leaf", async () => {
		session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage("aborted"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);

		const targetId = session.sessionManager.getEntries()[0]?.id;
		const originalLeafId = session.sessionManager.getLeafId();
		expect(targetId).toBeDefined();
		expect(originalLeafId).toBeDefined();

		const releasePreflight = createDeferred();
		const originalGetApiKey = session.modelRegistry.getApiKey.bind(session.modelRegistry);
		(
			session.modelRegistry as unknown as {
				getApiKey: (model: Parameters<ModelRegistry["getApiKey"]>[0]) => Promise<string | undefined>;
			}
		).getApiKey = async () => {
			await releasePreflight.promise;
			return undefined;
		};

		const promptPromise = session.prompt("blocked prompt").catch(() => {});
		let navigationResolved = false;
		const navigationPromise = session.navigateTree(targetId!, { summarize: false }).then((result) => {
			navigationResolved = true;
			return result;
		});

		await wait(20);
		expect(navigationResolved).toBe(false);
		expect(session.sessionManager.getLeafId()).toBe(originalLeafId);

		releasePreflight.resolve();
		await promptPromise;
		const navigationResult = await navigationPromise;
		expect(navigationResult.cancelled).toBe(false);
		expect(session.sessionManager.getLeafId()).toBeNull();
		(
			session.modelRegistry as unknown as {
				getApiKey: (model: Parameters<ModelRegistry["getApiKey"]>[0]) => Promise<string | undefined>;
			}
		).getApiKey = originalGetApiKey;
	});

	it("waits for a later settled window when non-dispatch callers try to mutate during agent_settled", async () => {
		session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage("aborted"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		const targetId = session.sessionManager.getEntries()[0]?.id;
		expect(targetId).toBeDefined();

		const releaseSettledHandler = createDeferred();
		let settledHandlerStarted = false;
		getInternals(session)._extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "agent_settled",
			emit: async (event: AgentSettledEvent) => {
				if (event.type === "agent_settled") {
					settledHandlerStarted = true;
					await releaseSettledHandler.promise;
				}
			},
		};

		const agentEndPromise = emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});
		await wait(20);
		expect(settledHandlerStarted).toBe(true);

		let navigationResolved = false;
		const navigationPromise = session.navigateTree(targetId!, { summarize: false }).then((result) => {
			navigationResolved = true;
			return result;
		});

		await wait(20);
		expect(navigationResolved).toBe(false);

		releaseSettledHandler.resolve();
		await agentEndPromise;
		await expect(navigationPromise).resolves.toMatchObject({ cancelled: false });
	});

	it("allows multiple tree mutations from the same awaited agent_settled dispatch", async () => {
		session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage("aborted"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage("aborted"));
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);

		const firstAssistantId = session.sessionManager.getEntries()[1]?.id;
		const secondAssistantId = session.sessionManager.getEntries()[3]?.id;
		expect(firstAssistantId).toBeDefined();
		expect(secondAssistantId).toBeDefined();

		const visitedLeafIds: Array<string | null> = [];
		getInternals(session)._extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "agent_settled",
			emit: async (event: AgentSettledEvent) => {
				if (event.type === "agent_settled") {
					await session.navigateTree(firstAssistantId!, { summarize: false });
					visitedLeafIds.push(session.sessionManager.getLeafId());
					await session.navigateTree(secondAssistantId!, { summarize: false });
					visitedLeafIds.push(session.sessionManager.getLeafId());
				}
			},
		};

		await emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});
		await session.waitForSettled({ timeoutMs: 500 });

		expect(visitedLeafIds).toEqual([firstAssistantId, secondAssistantId]);
		expect(session.sessionManager.getLeafId()).toBe(secondAssistantId);
	});

	it("aborts navigateTree from agent_settled when another turn lands during an awaited hook", async () => {
		session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage("aborted"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);

		const targetId = session.sessionManager.getEntries()[0]?.id;
		const originalLeafId = session.sessionManager.getLeafId();
		expect(targetId).toBeDefined();
		expect(originalLeafId).toBeDefined();

		const originalGetApiKey = session.modelRegistry.getApiKey.bind(session.modelRegistry);
		(
			session.modelRegistry as unknown as {
				getApiKey: (model: Parameters<ModelRegistry["getApiKey"]>[0]) => Promise<string | undefined>;
			}
		).getApiKey = async () => undefined;

		let mutationError: Error | undefined;
		getInternals(session)._extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "agent_settled" || eventType === "session_before_tree",
			emit: async (event: AgentSettledEvent | { type: "session_before_tree" }) => {
				if (event.type === "agent_settled") {
					await session.navigateTree(targetId!, { summarize: false }).catch((error: unknown) => {
						mutationError = error instanceof Error ? error : new Error(String(error));
					});
					return;
				}

				await expect(session.prompt("interleaving prompt")).rejects.toThrow("No API key found for anthropic");
			},
		} as unknown as AgentSessionTestInternals["_extensionRunner"];

		await emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});
		await session.waitForSettled({ timeoutMs: 500 });

		expect(mutationError).toBeDefined();
		expect(mutationError?.message).toContain("mutation");
		expect(session.sessionManager.getLeafId()).toBe(originalLeafId);
		(
			session.modelRegistry as unknown as {
				getApiKey: (model: Parameters<ModelRegistry["getApiKey"]>[0]) => Promise<string | undefined>;
			}
		).getApiKey = originalGetApiKey;
	});

	it("aborts fork from agent_settled when another turn lands during an awaited hook", async () => {
		session.sessionManager.appendMessage(createUserMessage("fork me"));
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);

		const entryId = session.sessionManager.getEntries()[0]?.id;
		const originalSessionId = session.sessionId;
		expect(entryId).toBeDefined();

		const originalGetApiKey = session.modelRegistry.getApiKey.bind(session.modelRegistry);
		(
			session.modelRegistry as unknown as {
				getApiKey: (model: Parameters<ModelRegistry["getApiKey"]>[0]) => Promise<string | undefined>;
			}
		).getApiKey = async () => undefined;

		let mutationError: Error | undefined;
		getInternals(session)._extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "agent_settled" || eventType === "session_before_fork",
			emit: async (event: AgentSettledEvent | { type: "session_before_fork" }) => {
				if (event.type === "agent_settled") {
					await session.fork(entryId!).catch((error: unknown) => {
						mutationError = error instanceof Error ? error : new Error(String(error));
					});
					return;
				}

				await expect(session.prompt("interleaving prompt")).rejects.toThrow("No API key found for anthropic");
			},
		} as unknown as AgentSessionTestInternals["_extensionRunner"];

		await emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});
		await session.waitForSettled({ timeoutMs: 500 });

		expect(mutationError).toBeDefined();
		expect(mutationError?.message).toContain("mutation");
		expect(session.sessionId).toBe(originalSessionId);
		(
			session.modelRegistry as unknown as {
				getApiKey: (model: Parameters<ModelRegistry["getApiKey"]>[0]) => Promise<string | undefined>;
			}
		).getApiKey = originalGetApiKey;
	});

	it("isolates async listener rejections during agent_settled dispatch", async () => {
		const originalConsoleError = console.error;
		const consoleErrors: unknown[][] = [];
		console.error = (...args: unknown[]) => {
			consoleErrors.push(args);
		};

		try {
			const settledStops: string[] = [];
			session.subscribe(async (event) => {
				if (event.type === "agent_settled") {
					await wait(0);
					throw new Error("async listener failed");
				}
			});
			session.subscribe((event) => {
				if (event.type === "agent_settled") {
					const assistant = event.messages[0] as { stopReason?: string } | undefined;
					settledStops.push(assistant?.stopReason ?? "none");
				}
			});

			await emitAgentEvent(session, {
				type: "agent_end",
				messages: [createAssistantMessage("aborted")],
			});
			await wait(20);
			await session.waitForSettled({ timeoutMs: 500 });

			expect(settledStops).toEqual(["aborted"]);
			expect(consoleErrors.some((args) => String(args[0]).includes("agent_settled"))).toBe(true);
		} finally {
			console.error = originalConsoleError;
		}
	});

	it("isolates listener errors during agent_settled dispatch", async () => {
		const settledStops: string[] = [];
		session.subscribe((event) => {
			if (event.type === "agent_settled") {
				throw new Error("listener failed");
			}
		});
		session.subscribe((event) => {
			if (event.type === "agent_settled") {
				const assistant = event.messages[0] as { stopReason?: string } | undefined;
				settledStops.push(assistant?.stopReason ?? "none");
			}
		});

		await emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("aborted")],
		});
		await emitAgentEvent(session, {
			type: "agent_end",
			messages: [createAssistantMessage("error")],
		});
		await session.waitForSettled({ timeoutMs: 500 });

		expect(settledStops).toEqual(["aborted", "error"]);
	});
});
