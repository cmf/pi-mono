import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type {
	AgentSettledEvent,
	Extension,
	ExtensionAgentSettledContext,
	ExtensionHandler,
	ExtensionRuntime,
} from "../src/core/extensions/types.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("agent_settled extension event", () => {
	beforeEach(() => {
		delete (globalThis as { settledHasNavigate?: boolean }).settledHasNavigate;
		delete (globalThis as { settledHasWaitForIdle?: boolean }).settledHasWaitForIdle;
		delete (globalThis as { settledHasAbort?: boolean }).settledHasAbort;
		delete (globalThis as { settledHasCompact?: boolean }).settledHasCompact;
		delete (globalThis as { settledHasShutdown?: boolean }).settledHasShutdown;
		delete (globalThis as { settledNavigateCancelled?: boolean }).settledNavigateCancelled;
	});

	afterEach(() => {
		delete (globalThis as { settledHasNavigate?: boolean }).settledHasNavigate;
		delete (globalThis as { settledHasWaitForIdle?: boolean }).settledHasWaitForIdle;
		delete (globalThis as { settledHasAbort?: boolean }).settledHasAbort;
		delete (globalThis as { settledHasCompact?: boolean }).settledHasCompact;
		delete (globalThis as { settledHasShutdown?: boolean }).settledHasShutdown;
		delete (globalThis as { settledNavigateCancelled?: boolean }).settledNavigateCancelled;
	});

	const createRuntime = (): ExtensionRuntime => {
		return {
			sendMessage: () => {
				throw new Error("not implemented");
			},
			sendUserMessage: () => {
				throw new Error("not implemented");
			},
			appendEntry: () => {
				throw new Error("not implemented");
			},
			setSessionName: () => {
				throw new Error("not implemented");
			},
			getSessionName: () => {
				throw new Error("not implemented");
			},
			setLabel: () => {
				throw new Error("not implemented");
			},
			getActiveTools: () => {
				throw new Error("not implemented");
			},
			getAllTools: () => {
				throw new Error("not implemented");
			},
			setActiveTools: () => {
				throw new Error("not implemented");
			},
			refreshTools: () => {
				throw new Error("not implemented");
			},
			getCommands: () => {
				throw new Error("not implemented");
			},
			setModel: () => {
				return Promise.reject(new Error("not implemented"));
			},
			getThinkingLevel: () => {
				throw new Error("not implemented");
			},
			setThinkingLevel: () => {
				throw new Error("not implemented");
			},
			registerProvider: () => {
				throw new Error("not implemented");
			},
			unregisterProvider: () => {
				throw new Error("not implemented");
			},
			flagValues: new Map(),
			pendingProviderRegistrations: [],
		};
	};

	const createRunner = (): ExtensionRunner => {
		const settledHandler: ExtensionHandler<AgentSettledEvent, undefined, ExtensionAgentSettledContext> = async (
			_event,
			ctx: ExtensionAgentSettledContext,
		) => {
			(globalThis as { settledHasNavigate?: boolean }).settledHasNavigate = typeof ctx.navigateTree === "function";
			(globalThis as { settledHasWaitForIdle?: boolean }).settledHasWaitForIdle = "waitForIdle" in ctx;
			(globalThis as { settledHasAbort?: boolean }).settledHasAbort = "abort" in ctx;
			(globalThis as { settledHasCompact?: boolean }).settledHasCompact = "compact" in ctx;
			(globalThis as { settledHasShutdown?: boolean }).settledHasShutdown = "shutdown" in ctx;
			const result = await ctx.navigateTree("entry-1", { summarize: false });
			(globalThis as { settledNavigateCancelled?: boolean }).settledNavigateCancelled = result.cancelled;
		};
		const voidReturningSettledHandler: ExtensionHandler<
			AgentSettledEvent,
			undefined,
			ExtensionAgentSettledContext
		> = async () => {};

		const extension: Extension = {
			path: "<test-extension>",
			resolvedPath: "<test-extension>",
			handlers: new Map([
				[
					"agent_settled",
					[
						settledHandler as unknown as (...args: unknown[]) => Promise<unknown>,
						voidReturningSettledHandler as unknown as (...args: unknown[]) => Promise<unknown>,
					],
				],
			]),
			tools: new Map(),
			messageRenderers: new Map(),
			commands: new Map(),
			flags: new Map(),
			shortcuts: new Map(),
		};
		const sessionManager = SessionManager.inMemory();
		const modelRegistry = {} as ModelRegistry;
		return new ExtensionRunner([extension], createRuntime(), tmpdir(), sessionManager, modelRegistry);
	};

	it("provides settled context matching ExtensionContext plus navigateTree", async () => {
		const runner = createRunner();

		runner.bindCommandContext({
			waitForIdle: async () => {},
			waitForSettled: async () => {},
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: true }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		});

		await runner.emit({ type: "agent_settled", messages: [] });

		expect((globalThis as { settledHasNavigate?: boolean }).settledHasNavigate).toBe(true);
		expect((globalThis as { settledHasWaitForIdle?: boolean }).settledHasWaitForIdle).toBe(false);
		expect((globalThis as { settledHasAbort?: boolean }).settledHasAbort).toBe(true);
		expect((globalThis as { settledHasCompact?: boolean }).settledHasCompact).toBe(true);
		expect((globalThis as { settledHasShutdown?: boolean }).settledHasShutdown).toBe(true);
		expect((globalThis as { settledNavigateCancelled?: boolean }).settledNavigateCancelled).toBe(true);
	});
});
