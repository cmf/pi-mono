import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcLifecycleCoordinator } from "../src/modes/rpc/rpc-lifecycle-coordinator.js";

type CoordinatorEvent = { type: string; requestId?: string; messages?: unknown[] };

type CoordinatorInternals = {
	state: {
		requests: Map<string, unknown>;
	};
};

const getInternals = (coordinator: RpcLifecycleCoordinator): CoordinatorInternals => {
	return coordinator as unknown as CoordinatorInternals;
};

const waitForAsyncWork = async (): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe("RpcLifecycleCoordinator", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("consumes queued-command ack rejections when invoke fails", async () => {
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown): void => {
			unhandledRejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);

		try {
			const coordinator = new RpcLifecycleCoordinator(
				() => {},
				() => true,
			);

			await expect(
				coordinator.submitQueuedCommand("req_1", "steer", async () => {
					throw new Error("steer failed");
				}),
			).rejects.toThrow("steer failed");
			await waitForAsyncWork();

			expect(unhandledRejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandledRejection);
		}
	});

	it("waits for the active lifecycle to settle before starting another prompt", async () => {
		const outputEvents: CoordinatorEvent[] = [];
		let isSettled = false;
		const coordinator = new RpcLifecycleCoordinator(
			(event) => {
				outputEvents.push(event as CoordinatorEvent);
			},
			() => isSettled,
		);

		const firstPrompt = coordinator.submitPrompt("req_1", async () => {
			await new Promise<void>(() => {});
		});
		await waitForAsyncWork();
		coordinator.handleSessionEvent({ type: "agent_start" });
		await expect(firstPrompt).resolves.toMatchObject({ accepted: true, hasLifecycle: true, isSettled: false });

		coordinator.handleSessionEvent({ type: "agent_end", messages: [] });

		let secondPromptInvoked = false;
		const secondPrompt = coordinator.submitPrompt("req_2", async () => {
			secondPromptInvoked = true;
			await new Promise<void>(() => {});
		});
		await waitForAsyncWork();
		expect(secondPromptInvoked).toBe(false);

		coordinator.handleSessionEvent({ type: "agent_start" });
		await waitForAsyncWork();
		expect(secondPromptInvoked).toBe(false);
		expect(outputEvents).toEqual([
			{ type: "agent_start", requestId: "req_1" },
			{ type: "agent_end", requestId: "req_1", messages: [] },
			{ type: "agent_start", requestId: "req_1" },
		]);

		isSettled = true;
		coordinator.handleSessionEvent({ type: "agent_settled", messages: [] });
		await waitForAsyncWork();
		expect(secondPromptInvoked).toBe(true);

		isSettled = false;
		coordinator.handleSessionEvent({ type: "agent_start" });
		await expect(secondPrompt).resolves.toMatchObject({ accepted: true, hasLifecycle: true, isSettled: false });
		expect(outputEvents).toEqual([
			{ type: "agent_start", requestId: "req_1" },
			{ type: "agent_end", requestId: "req_1", messages: [] },
			{ type: "agent_start", requestId: "req_1" },
			{ type: "agent_settled", requestId: "req_1", messages: [] },
			{ type: "agent_start", requestId: "req_2" },
		]);
	});

	it("prunes closed requests after terminal effects are emitted", async () => {
		const coordinator = new RpcLifecycleCoordinator(
			() => {},
			() => true,
		);

		const prompt = coordinator.submitPrompt("req_prompt", async () => {
			await new Promise<void>(() => {});
		});
		await waitForAsyncWork();
		coordinator.handleSessionEvent({ type: "agent_start" });
		await prompt;
		coordinator.handleSessionEvent({ type: "agent_end", messages: [] });
		coordinator.handleSessionEvent({ type: "agent_settled", messages: [] });
		await waitForAsyncWork();
		expect(getInternals(coordinator).state.requests.size).toBe(0);

		await coordinator.submitQueuedCommand("req_steer", "steer", async () => {});
		expect(getInternals(coordinator).state.requests.size).toBe(0);
	});
});
