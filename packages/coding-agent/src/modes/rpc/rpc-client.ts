/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { AgentMessage, ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { AgentSessionEvent, SessionStats } from "../../core/agent-session.js";
import type { BashResult } from "../../core/bash-executor.js";
import type { CompactionResult } from "../../core/compaction/index.js";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	RpcAgentSessionEvent,
	RpcCommand,
	RpcEvent,
	RpcResponse,
	RpcSessionState,
	RpcSlashCommand,
} from "./rpc-types.js";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export interface RpcLifecycleHandle {
	requestId: string;
	waitForIdle(timeout?: number): Promise<void>;
	collectEvents(timeout?: number): Promise<AgentSessionEvent[]>;
}

interface RequestLifecycleTracker {
	requestId: string;
	idleState: "pending" | "ended" | "failed";
	error?: Error;
	cleanupTimer?: ReturnType<typeof setTimeout>;
}

export type RpcEventListener = (event: RpcEvent) => void;

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private eventListeners: RpcEventListener[] = [];
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";
	private isSettledState = false;
	private pendingSettlementAffectingRequests = 0;
	private settlementStateListeners = new Set<() => void>();
	private requestLifecycleTrackers = new Map<string, RequestLifecycleTracker>();

	constructor(private options: RpcClientOptions = {}) {}

	/**
	 * Start the RPC agent process.
	 */
	async start(): Promise<void> {
		if (this.process) {
			throw new Error("Client already started");
		}

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		this.process = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});

		// Collect stderr for debugging
		this.process.stderr?.on("data", (data) => {
			this.stderr += data.toString();
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(this.process.stdout!, (line) => {
			this.handleLine(line);
		});

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			throw new Error(`Agent process exited immediately with code ${this.process.exitCode}. Stderr: ${this.stderr}`);
		}

		const state = await this.getState();
		this.isSettledState = state.isSettled;
	}

	/**
	 * Stop the RPC agent process.
	 */
	async stop(): Promise<void> {
		if (!this.process) return;

		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.process.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
		this.pendingRequests.clear();
		for (const tracker of this.requestLifecycleTrackers.values()) {
			if (tracker.cleanupTimer) {
				clearTimeout(tracker.cleanupTimer);
			}
		}
		this.requestLifecycleTrackers.clear();
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<RpcLifecycleHandle> {
		const pendingCommand = this.startSettlementAffectingCommand({ type: "prompt", message, images });
		await pendingCommand.responsePromise;
		return this.createLifecycleHandle(pendingCommand.requestId);
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<RpcLifecycleHandle> {
		const pendingCommand = this.startSettlementAffectingCommand({ type: "steer", message, images });
		await pendingCommand.responsePromise;
		return this.createLifecycleHandle(pendingCommand.requestId);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<RpcLifecycleHandle> {
		const pendingCommand = this.startSettlementAffectingCommand({ type: "follow_up", message, images });
		await pendingCommand.responsePromise;
		return this.createLifecycleHandle(pendingCommand.requestId);
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		const state = this.getData<RpcSessionState>(response);
		this.isSettledState = state.isSettled;
		return state;
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	private canResolveWaitForSettled(): boolean {
		return this.isSettledState && this.pendingSettlementAffectingRequests === 0;
	}

	private notifySettlementStateChanged(): void {
		for (const listener of this.settlementStateListeners) {
			listener();
		}
	}

	private getOrCreateRequestLifecycleTracker(requestId: string): RequestLifecycleTracker {
		const existingTracker = this.requestLifecycleTrackers.get(requestId);
		if (existingTracker) {
			return existingTracker;
		}

		const tracker: RequestLifecycleTracker = {
			requestId,
			idleState: "pending",
		};
		this.requestLifecycleTrackers.set(requestId, tracker);
		return tracker;
	}

	private scheduleRequestLifecycleTrackerCleanup(tracker: RequestLifecycleTracker): void {
		if (tracker.cleanupTimer) {
			clearTimeout(tracker.cleanupTimer);
		}
		tracker.cleanupTimer = setTimeout(() => {
			if (this.requestLifecycleTrackers.get(tracker.requestId) === tracker) {
				this.requestLifecycleTrackers.delete(tracker.requestId);
			}
		}, 60000);
	}

	private markRequestLifecycleFailure(requestId: string, error: Error): void {
		const tracker = this.getOrCreateRequestLifecycleTracker(requestId);
		if (tracker.idleState === "failed") {
			this.scheduleRequestLifecycleTrackerCleanup(tracker);
			return;
		}
		tracker.idleState = "failed";
		tracker.error = error;
		this.scheduleRequestLifecycleTrackerCleanup(tracker);
	}

	private markRequestLifecycleEnded(requestId: string): void {
		const tracker = this.getOrCreateRequestLifecycleTracker(requestId);
		if (tracker.idleState === "failed") {
			this.scheduleRequestLifecycleTrackerCleanup(tracker);
			return;
		}
		tracker.idleState = "ended";
		tracker.error = undefined;
		this.scheduleRequestLifecycleTrackerCleanup(tracker);
	}

	private getRequestLifecycleTerminalState(requestId: string): { ended: boolean; error?: Error } | undefined {
		const tracker = this.requestLifecycleTrackers.get(requestId);
		if (!tracker || tracker.idleState === "pending") {
			return undefined;
		}
		return tracker.idleState === "failed" ? { ended: false, error: tracker.error } : { ended: true };
	}

	private createCommandError(event: Extract<RpcEvent, { type: "command_error" }>): Error {
		return new Error(event.error);
	}

	private createLifecycleHandle(requestId: string): RpcLifecycleHandle {
		const handle: RpcLifecycleHandle = {
			requestId,
			waitForIdle: (timeout = 60000) => this.waitForIdle(handle, timeout),
			collectEvents: (timeout = 60000) => this.collectEvents(handle, timeout),
		};
		return handle;
	}

	private createRequestIdleWaiter(requestId: string, timeout: number): Promise<void> {
		const terminalState = this.getRequestLifecycleTerminalState(requestId);
		if (terminalState?.error) {
			return Promise.reject(terminalState.error);
		}
		if (terminalState?.ended) {
			return Promise.resolve();
		}

		return new Promise((resolve, reject) => {
			let unsubscribe = () => {};
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			unsubscribe = this.onEvent((event) => {
				if (event.type === "command_error" && event.requestId === requestId) {
					clearTimeout(timer);
					unsubscribe();
					reject(this.createCommandError(event));
					return;
				}
				if (event.type === "agent_end" && event.requestId === requestId) {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	private createRequestEventCollector(
		requestId: string,
		timeout: number,
	): { promise: Promise<AgentSessionEvent[]>; cancel: (error: Error) => void } {
		const terminalState = this.getRequestLifecycleTerminalState(requestId);
		if (terminalState?.error) {
			return {
				promise: Promise.reject(terminalState.error),
				cancel: () => {},
			};
		}
		if (terminalState?.ended) {
			return {
				promise: Promise.resolve([]),
				cancel: () => {},
			};
		}

		const events: AgentSessionEvent[] = [];
		let unsubscribe = () => {};
		let finished = false;
		let rejectPromise!: (error: Error) => void;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (callback: () => void): void => {
			if (finished) {
				return;
			}
			finished = true;
			if (timer) {
				clearTimeout(timer);
			}
			unsubscribe();
			callback();
		};

		const promise = new Promise<AgentSessionEvent[]>((resolve, reject) => {
			rejectPromise = reject;
			timer = setTimeout(() => {
				finish(() => reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`)));
			}, timeout);

			unsubscribe = this.onEvent((event) => {
				if (event.type === "command_error" && event.requestId === requestId) {
					finish(() => reject(this.createCommandError(event)));
					return;
				}
				if (!this.isAgentSessionEvent(event)) {
					return;
				}
				events.push(event);
				if (event.type === "agent_end" && event.requestId === requestId) {
					finish(() => resolve(events));
				}
			});
		});

		return {
			promise,
			cancel: (error) => {
				finish(() => rejectPromise(error));
			},
		};
	}

	private startSettlementAffectingCommand(
		command: Extract<RpcCommandBody, { type: "prompt" | "steer" | "follow_up" }>,
	): { requestId: string; responsePromise: Promise<void> } {
		const requestId = `req_${++this.requestId}`;
		this.getOrCreateRequestLifecycleTracker(requestId);
		this.pendingSettlementAffectingRequests++;
		this.notifySettlementStateChanged();

		const responsePromise = this.send(command, requestId)
			.then((response) => {
				const hasLifecycle = this.syncSettledStateFromResponse(response, requestId);
				if (!hasLifecycle) {
					this.markRequestLifecycleEnded(requestId);
				}
			})
			.catch((error: unknown) => {
				this.requestLifecycleTrackers.delete(requestId);
				throw error;
			});
		void responsePromise
			.finally(() => {
				this.pendingSettlementAffectingRequests--;
				this.notifySettlementStateChanged();
			})
			.catch(() => {});

		return { requestId, responsePromise };
	}

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(handleOrTimeout: RpcLifecycleHandle | number = 60000, timeout = 60000): Promise<void> {
		if (typeof handleOrTimeout !== "number") {
			return this.createRequestIdleWaiter(handleOrTimeout.requestId, timeout);
		}

		const globalTimeout = handleOrTimeout;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, globalTimeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Wait for agent lifecycle to settle (no queued continuation).
	 * Resolves when agent_settled event is received.
	 */
	async waitForSettled(timeout = 60000): Promise<void> {
		if (this.canResolveWaitForSettled()) {
			return;
		}

		await new Promise<void>((resolve, reject) => {
			let finished = false;
			const finish = (error?: Error): void => {
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timer);
				this.settlementStateListeners.delete(onStateChange);
				if (error) {
					reject(error);
					return;
				}
				resolve();
			};

			const onStateChange = (): void => {
				if (this.canResolveWaitForSettled()) {
					finish();
				}
			};

			const timer = setTimeout(() => {
				finish(new Error(`Timeout waiting for agent to settle. Stderr: ${this.stderr}`));
			}, timeout);

			this.settlementStateListeners.add(onStateChange);
			onStateChange();
		});
	}

	/**
	 * Collect events until agent becomes idle (`agent_end`), not until the session fully settles.
	 */
	collectEvents(handleOrTimeout: RpcLifecycleHandle | number = 60000, timeout = 60000): Promise<AgentSessionEvent[]> {
		if (typeof handleOrTimeout !== "number") {
			return this.createRequestEventCollector(handleOrTimeout.requestId, timeout).promise;
		}

		const globalTimeout = handleOrTimeout;
		return new Promise((resolve, reject) => {
			const events: AgentSessionEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, globalTimeout);

			const unsubscribe = this.onEvent((event) => {
				if (!this.isAgentSessionEvent(event)) {
					return;
				}
				events.push(event);
				if (event.type === "agent_end") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * Send prompt and wait until the agent becomes idle (`agent_end`), returning all events seen up to that point.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentSessionEvent[]> {
		const pendingCommand = this.startSettlementAffectingCommand({ type: "prompt", message, images });
		const collector = this.createRequestEventCollector(pendingCommand.requestId, timeout);
		void collector.promise.catch(() => {});
		try {
			await pendingCommand.responsePromise;
			return await collector.promise;
		} catch (error) {
			const normalizedError = error instanceof Error ? error : new Error(String(error));
			collector.cancel(normalizedError);
			throw normalizedError;
		}
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleLine(line: string): void {
		try {
			const data = JSON.parse(line);

			if (data.type === "response") {
				if (data.id && this.pendingRequests.has(data.id)) {
					const response = data as RpcResponse;
					const pending = this.pendingRequests.get(data.id)!;
					this.pendingRequests.delete(data.id);
					pending.resolve(response);
				}
				return;
			}

			const event = data as RpcEvent;
			if (event.type === "command_error") {
				this.isSettledState = event.isSettled;
				if (event.requestId) {
					this.markRequestLifecycleFailure(event.requestId, this.createCommandError(event));
				}
			} else if (event.type === "agent_settled") {
				this.isSettledState = true;
			} else if (event.type === "agent_start" || event.type === "agent_end") {
				this.isSettledState = false;
				if (event.type === "agent_end" && event.requestId) {
					this.markRequestLifecycleEnded(event.requestId);
				}
			}
			this.notifySettlementStateChanged();

			for (const listener of this.eventListeners) {
				listener(event);
			}
		} catch {
			// Ignore non-JSON lines
		}
	}

	private syncSettledStateFromResponse(response: RpcResponse, requestId: string): boolean {
		if (!response.success) {
			throw new Error(response.error);
		}

		if (response.command === "prompt" || response.command === "steer" || response.command === "follow_up") {
			const data = response.data;
			if (!data || typeof data !== "object" || !("isSettled" in data) || typeof data.isSettled !== "boolean") {
				throw new Error(`Malformed ${response.command} response for ${requestId}`);
			}
			this.isSettledState = data.isSettled;
			if ("hasLifecycle" in data) {
				if (typeof data.hasLifecycle !== "boolean") {
					throw new Error(`Malformed ${response.command} response for ${requestId}`);
				}
				return data.hasLifecycle;
			}
		}

		return true;
	}

	private isAgentSessionEvent(event: RpcEvent): event is RpcAgentSessionEvent {
		return event.type !== "command_error" && event.type !== "extension_error";
	}

	private async send(command: RpcCommandBody, requestId?: string): Promise<RpcResponse> {
		if (!this.process?.stdin) {
			throw new Error("Client not started");
		}

		const id = requestId ?? `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			this.pendingRequests.set(id, { resolve, reject });

			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, 30000);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					reject(error);
				},
			});

			this.process!.stdin!.write(serializeJsonLine(fullCommand));
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
