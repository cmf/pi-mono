import type { AgentSessionEvent } from "../../core/agent-session.js";
import type {
	RpcAgentSessionEvent,
	RpcCommand,
	RpcCommandErrorEvent,
	RpcExtensionErrorEvent,
	RpcExtensionUIRequest,
	RpcResponse,
} from "./rpc-types.js";

type LifecycleCommand = Extract<RpcCommand["type"], "prompt" | "steer" | "follow_up">;
type RequestPhase = "pending_ack" | "active_run";
type RunState = "idle" | "running" | "waiting_for_settled";

interface LifecycleRequestState {
	command: LifecycleCommand;
	phase: RequestPhase;
	hasLifecycle: boolean;
}

interface LifecycleState {
	runState: RunState;
	activeRequestId?: string;
	pendingPromptStartRequestId?: string;
	requests: Map<string, LifecycleRequestState>;
}

type LifecycleAction =
	| { type: "request_reserved"; requestId: string; command: LifecycleCommand }
	| { type: "request_completed_without_lifecycle"; requestId: string }
	| { type: "request_invocation_failed"; requestId: string; error: string; isSettled: boolean }
	| { type: "request_lifecycle_cancelled"; error: string; isSettled: boolean }
	| { type: "session_event"; event: AgentSessionEvent };

type LifecycleEffect =
	| { type: "resolve_ack"; requestId: string; hasLifecycle: boolean }
	| { type: "reject_ack"; requestId: string; error: string }
	| {
			type: "emit_agent_event";
			event: RpcAgentSessionEvent;
	  }
	| { type: "emit_command_error"; event: RpcCommandErrorEvent };

interface Deferred<T> {
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

const initialState = (): LifecycleState => ({
	runState: "idle",
	requests: new Map<string, LifecycleRequestState>(),
});

const withoutRequest = (state: LifecycleState, requestId: string): LifecycleState => {
	if (!state.requests.has(requestId)) {
		return state;
	}
	const requests = new Map(state.requests);
	requests.delete(requestId);
	return { ...state, requests };
};

const reducer = (
	state: LifecycleState,
	action: LifecycleAction,
): { state: LifecycleState; effects: LifecycleEffect[] } => {
	switch (action.type) {
		case "request_reserved": {
			const requests = new Map(state.requests);
			requests.set(action.requestId, {
				command: action.command,
				phase: "pending_ack",
				hasLifecycle: false,
			});
			return {
				state: {
					...state,
					requests,
					pendingPromptStartRequestId:
						action.command === "prompt" ? action.requestId : state.pendingPromptStartRequestId,
				},
				effects: [],
			};
		}

		case "request_completed_without_lifecycle": {
			const request = state.requests.get(action.requestId);
			if (!request || request.phase !== "pending_ack") {
				return { state, effects: [] };
			}
			const nextState = withoutRequest(
				{
					...state,
					pendingPromptStartRequestId:
						state.pendingPromptStartRequestId === action.requestId
							? undefined
							: state.pendingPromptStartRequestId,
				},
				action.requestId,
			);
			return {
				state: nextState,
				effects: [{ type: "resolve_ack", requestId: action.requestId, hasLifecycle: false }],
			};
		}

		case "request_invocation_failed": {
			const request = state.requests.get(action.requestId);
			if (!request) {
				return { state, effects: [] };
			}

			if (request.phase === "pending_ack") {
				const nextState = withoutRequest(
					{
						...state,
						pendingPromptStartRequestId:
							state.pendingPromptStartRequestId === action.requestId
								? undefined
								: state.pendingPromptStartRequestId,
					},
					action.requestId,
				);
				return {
					state: nextState,
					effects: [{ type: "reject_ack", requestId: action.requestId, error: action.error }],
				};
			}

			if (request.phase === "active_run") {
				const isActiveRequest = state.activeRequestId === action.requestId;
				const nextState = withoutRequest(
					{
						...state,
						activeRequestId: isActiveRequest ? undefined : state.activeRequestId,
						runState: isActiveRequest ? (action.isSettled ? "idle" : state.runState) : state.runState,
					},
					action.requestId,
				);
				return {
					state: nextState,
					effects: [
						{
							type: "emit_command_error",
							event: {
								type: "command_error",
								command: request.command,
								requestId: action.requestId,
								error: action.error,
								isSettled: action.isSettled,
							},
						},
					],
				};
			}

			return { state, effects: [] };
		}

		case "request_lifecycle_cancelled": {
			const effects: LifecycleEffect[] = [];
			for (const [requestId, request] of state.requests) {
				if (request.phase === "pending_ack") {
					effects.push({ type: "reject_ack", requestId, error: action.error });
					continue;
				}

				effects.push({
					type: "emit_command_error",
					event: {
						type: "command_error",
						command: request.command,
						requestId,
						error: action.error,
						isSettled: action.isSettled,
					},
				});
			}
			return { state: initialState(), effects };
		}

		case "session_event": {
			const event = action.event;
			if (event.type === "agent_start") {
				if (state.pendingPromptStartRequestId) {
					const requestId = state.pendingPromptStartRequestId;
					const request = state.requests.get(requestId);
					if (!request) {
						return {
							state: {
								...state,
								runState: "running",
								pendingPromptStartRequestId: undefined,
							},
							effects: [{ type: "emit_agent_event", event }],
						};
					}
					const requests = new Map(state.requests);
					requests.set(requestId, { ...request, phase: "active_run", hasLifecycle: true });
					return {
						state: {
							...state,
							runState: "running",
							activeRequestId: requestId,
							pendingPromptStartRequestId: undefined,
							requests,
						},
						effects: [
							{ type: "resolve_ack", requestId, hasLifecycle: true },
							{ type: "emit_agent_event", event: { ...event, requestId } },
						],
					};
				}

				if (state.activeRequestId) {
					return {
						state: { ...state, runState: "running" },
						effects: [{ type: "emit_agent_event", event: { ...event, requestId: state.activeRequestId } }],
					};
				}

				return {
					state: { ...state, runState: "running" },
					effects: [{ type: "emit_agent_event", event }],
				};
			}

			if (event.type === "agent_end") {
				if (state.activeRequestId) {
					return {
						state: { ...state, runState: "waiting_for_settled" },
						effects: [{ type: "emit_agent_event", event: { ...event, requestId: state.activeRequestId } }],
					};
				}
				return {
					state: { ...state, runState: "waiting_for_settled" },
					effects: [{ type: "emit_agent_event", event }],
				};
			}

			if (event.type === "agent_settled") {
				if (state.activeRequestId) {
					const requestId = state.activeRequestId;
					return {
						state: withoutRequest(
							{
								...state,
								runState: "idle",
								activeRequestId: undefined,
							},
							requestId,
						),
						effects: [{ type: "emit_agent_event", event: { ...event, requestId } }],
					};
				}
				return {
					state: { ...state, runState: "idle" },
					effects: [{ type: "emit_agent_event", event }],
				};
			}

			return { state, effects: [{ type: "emit_agent_event", event }] };
		}
	}
};

const toError = (message: string): Error => new Error(message);

export class RpcLifecycleCoordinator {
	private state: LifecycleState = initialState();
	private readonly pendingAcks = new Map<string, Deferred<boolean>>();
	private promptSubmissionQueue: Promise<void> = Promise.resolve();
	private readonly promptStartWaiters: Array<() => void> = [];

	constructor(
		private readonly output: (
			obj: RpcResponse | RpcExtensionUIRequest | RpcCommandErrorEvent | RpcExtensionErrorEvent | object,
		) => void,
		private readonly getIsSettled: () => boolean,
	) {}

	handleSessionEvent(event: AgentSessionEvent): void {
		this.dispatch({ type: "session_event", event });
	}

	cancelActiveRequests(reason: string, isSettled = this.getIsSettled()): void {
		this.dispatch({
			type: "request_lifecycle_cancelled",
			error: `Request lifecycle was cancelled by ${reason}`,
			isSettled,
		});
	}

	async submitPrompt(
		requestId: string,
		invoke: () => Promise<void>,
	): Promise<{ accepted: true; isSettled: boolean; hasLifecycle: boolean }> {
		return this.enqueuePromptSubmission(async () => {
			await this.waitForPromptStartWindow();
			const ackPromise = this.reserveRequest(requestId, "prompt");
			const promptPromise = Promise.resolve().then(invoke);
			void promptPromise.then(
				() => {
					this.dispatch({ type: "request_completed_without_lifecycle", requestId });
				},
				(error: unknown) => {
					this.dispatch({
						type: "request_invocation_failed",
						requestId,
						error: error instanceof Error ? error.message : String(error),
						isSettled: this.getIsSettled(),
					});
				},
			);
			const hasLifecycle = await ackPromise;
			return { accepted: true, isSettled: this.getIsSettled(), hasLifecycle };
		});
	}

	async submitQueuedCommand(
		requestId: string,
		command: Extract<LifecycleCommand, "steer" | "follow_up">,
		invoke: () => Promise<void>,
	): Promise<{ accepted: true; isSettled: boolean; hasLifecycle: false }> {
		const ackPromise = this.reserveRequest(requestId, command);
		try {
			await invoke();
			this.dispatch({ type: "request_completed_without_lifecycle", requestId });
			await ackPromise;
			return { accepted: true, isSettled: this.getIsSettled(), hasLifecycle: false };
		} catch (error) {
			this.dispatch({
				type: "request_invocation_failed",
				requestId,
				error: error instanceof Error ? error.message : String(error),
				isSettled: this.getIsSettled(),
			});
			await ackPromise.catch(() => undefined);
			throw error;
		}
	}

	private canStartPromptLifecycle(): boolean {
		return (
			this.state.runState === "idle" &&
			this.state.activeRequestId === undefined &&
			this.state.pendingPromptStartRequestId === undefined
		);
	}

	private async waitForPromptStartWindow(): Promise<void> {
		if (this.canStartPromptLifecycle()) {
			return;
		}
		await new Promise<void>((resolve) => {
			this.promptStartWaiters.push(resolve);
		});
	}

	private resolvePromptStartWaitersIfReady(): void {
		if (!this.canStartPromptLifecycle()) {
			return;
		}
		while (this.promptStartWaiters.length > 0) {
			this.promptStartWaiters.shift()?.();
		}
	}

	private reserveRequest(requestId: string, command: LifecycleCommand): Promise<boolean> {
		this.dispatch({ type: "request_reserved", requestId, command });
		return new Promise<boolean>((resolve, reject) => {
			this.pendingAcks.set(requestId, { resolve, reject });
		});
	}

	private dispatch(action: LifecycleAction): void {
		const reduced = reducer(this.state, action);
		this.state = reduced.state;
		for (const effect of reduced.effects) {
			this.applyEffect(effect);
		}
		this.resolvePromptStartWaitersIfReady();
	}

	private applyEffect(effect: LifecycleEffect): void {
		if (effect.type === "resolve_ack") {
			const pendingAck = this.pendingAcks.get(effect.requestId);
			if (!pendingAck) {
				return;
			}
			this.pendingAcks.delete(effect.requestId);
			pendingAck.resolve(effect.hasLifecycle);
			return;
		}

		if (effect.type === "reject_ack") {
			const pendingAck = this.pendingAcks.get(effect.requestId);
			if (!pendingAck) {
				return;
			}
			this.pendingAcks.delete(effect.requestId);
			pendingAck.reject(toError(effect.error));
			return;
		}

		if (effect.type === "emit_agent_event") {
			this.output(effect.event);
			return;
		}

		this.output(effect.event);
	}

	private async enqueuePromptSubmission<T>(task: () => Promise<T>): Promise<T> {
		const runTask = this.promptSubmissionQueue.then(task, task);
		this.promptSubmissionQueue = runTask.then(
			() => undefined,
			() => undefined,
		);
		return runTask;
	}
}
