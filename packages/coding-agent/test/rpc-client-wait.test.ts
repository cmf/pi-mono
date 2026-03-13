import { describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";

const wait = async (ms: number): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

describe("RpcClient wait helpers", () => {
	it("waitForSettled resolves only after agent_settled", async () => {
		const client = new RpcClient();
		const clientInternals = client as unknown as { handleLine: (line: string) => void };

		let resolved = false;
		const settledPromise = client.waitForSettled(500).then(() => {
			resolved = true;
		});

		clientInternals.handleLine(JSON.stringify({ type: "agent_end", messages: [] }));
		await wait(20);
		expect(resolved).toBe(false);

		clientInternals.handleLine(JSON.stringify({ type: "agent_settled", messages: [] }));
		await settledPromise;
		expect(resolved).toBe(true);
	});

	it("waitForIdle remains tied to agent_end", async () => {
		const client = new RpcClient();
		const clientInternals = client as unknown as { handleLine: (line: string) => void };

		let resolved = false;
		const idlePromise = client.waitForIdle(500).then(() => {
			resolved = true;
		});

		clientInternals.handleLine(JSON.stringify({ type: "agent_settled", messages: [] }));
		await wait(20);
		expect(resolved).toBe(false);

		clientInternals.handleLine(JSON.stringify({ type: "agent_end", messages: [] }));
		await idlePromise;
		expect(resolved).toBe(true);
	});

	it("waitForSettled waits for agent_settled without consulting get_state", async () => {
		const client = new RpcClient();
		const clientInternals = client as unknown as {
			handleLine: (line: string) => void;
			send: (command: { type: string }) => Promise<unknown>;
			isSettledState: boolean;
		};
		clientInternals.isSettledState = false;
		clientInternals.send = async (command) => {
			throw new Error(`unexpected command: ${command.type}`);
		};

		let resolved = false;
		const settledPromise = client.waitForSettled(500).then(() => {
			resolved = true;
		});

		await wait(20);
		expect(resolved).toBe(false);

		clientInternals.handleLine(JSON.stringify({ type: "agent_settled", messages: [] }));
		await settledPromise;
		expect(resolved).toBe(true);
	});

	it("prompt uses authoritative settled state from the server response", async () => {
		const client = new RpcClient();
		const clientInternals = client as unknown as {
			handleLine: (line: string) => void;
			send: (command: { type: string; message?: string }) => Promise<unknown>;
			isSettledState: boolean;
		};
		clientInternals.isSettledState = true;
		clientInternals.send = async (command) => {
			expect(command.type).toBe("prompt");
			await wait(60);
			return { type: "response", command: "prompt", success: true, data: { accepted: true, isSettled: false } };
		};

		const promptPromise = client.prompt("hello");
		await wait(20);
		let settledResolved = false;
		const settledPromise = client.waitForSettled(500).then(() => {
			settledResolved = true;
		});

		await promptPromise;
		await wait(20);
		expect(settledResolved).toBe(false);

		clientInternals.handleLine(JSON.stringify({ type: "agent_settled", messages: [] }));
		await settledPromise;
		expect(settledResolved).toBe(true);
	});

	it("command_error re-synchronizes settled state after an accepted prompt fails", async () => {
		const client = new RpcClient();
		const events: Array<{ type: string; error?: string }> = [];
		client.onEvent((event) => {
			events.push(event as { type: string; error?: string });
		});
		const clientInternals = client as unknown as {
			handleLine: (line: string) => void;
			send: (command: { type: string; message?: string }) => Promise<unknown>;
			isSettledState: boolean;
		};
		clientInternals.isSettledState = true;
		clientInternals.send = async () => {
			return {
				id: "req_prompt",
				type: "response",
				command: "prompt",
				success: true,
				data: { accepted: true, isSettled: false },
			};
		};

		await client.prompt("hello");
		let settledResolved = false;
		const settledPromise = client.waitForSettled(500).then(() => {
			settledResolved = true;
		});

		await wait(20);
		expect(settledResolved).toBe(false);

		clientInternals.handleLine(
			JSON.stringify({
				type: "command_error",
				command: "prompt",
				requestId: "req_prompt",
				error: "prompt failed",
				isSettled: true,
			}),
		);
		await settledPromise;

		expect(settledResolved).toBe(true);
		expect(events).toContainEqual({
			type: "command_error",
			command: "prompt",
			requestId: "req_prompt",
			error: "prompt failed",
			isSettled: true,
		});
	});

	it("request-scoped waitForIdle rejects when its accepted prompt fails before agent_start", async () => {
		const client = new RpcClient();
		const clientInternals = client as unknown as {
			handleLine: (line: string) => void;
			send: (command: { type: string; message?: string }) => Promise<unknown>;
			isSettledState: boolean;
		};
		clientInternals.isSettledState = true;
		clientInternals.send = async () => {
			return {
				id: "req_prompt",
				type: "response",
				command: "prompt",
				success: true,
				data: { accepted: true, isSettled: false },
			};
		};

		const handle = await client.prompt("hello");
		const idlePromise = client.waitForIdle(handle, 500);

		clientInternals.handleLine(
			JSON.stringify({
				type: "command_error",
				command: "prompt",
				requestId: handle.requestId,
				error: "prompt failed",
				isSettled: true,
			}),
		);

		await expect(idlePromise).rejects.toThrow("prompt failed");
	});

	it("request-scoped collectEvents rejects when its accepted prompt fails before agent_start", async () => {
		const client = new RpcClient();
		const clientInternals = client as unknown as {
			handleLine: (line: string) => void;
			send: (command: { type: string; message?: string }) => Promise<unknown>;
			isSettledState: boolean;
		};
		clientInternals.isSettledState = true;
		clientInternals.send = async () => {
			return {
				id: "req_prompt",
				type: "response",
				command: "prompt",
				success: true,
				data: { accepted: true, isSettled: false },
			};
		};

		const handle = await client.prompt("hello");
		const eventsPromise = client.collectEvents(handle, 500);

		clientInternals.handleLine(
			JSON.stringify({
				type: "command_error",
				command: "prompt",
				requestId: handle.requestId,
				error: "prompt failed",
				isSettled: true,
			}),
		);

		await expect(eventsPromise).rejects.toThrow("prompt failed");
	});

	it("request-scoped waiters do not cross-correlate concurrent prompt failures", async () => {
		const client = new RpcClient();
		const clientInternals = client as unknown as {
			handleLine: (line: string) => void;
			send: (command: { type: string; message?: string }) => Promise<unknown>;
			isSettledState: boolean;
		};
		clientInternals.isSettledState = true;
		let requestCounter = 0;
		clientInternals.send = async (command) => {
			requestCounter++;
			return {
				id: `req_${requestCounter}`,
				type: "response",
				command: command.type,
				success: true,
				data: { accepted: true, isSettled: false },
			};
		};

		const firstHandle = await client.prompt("first");
		const secondHandle = await client.prompt("second");

		const firstIdlePromise = client.waitForIdle(firstHandle, 500);
		const secondIdlePromise = client.waitForIdle(secondHandle, 500);

		clientInternals.handleLine(
			JSON.stringify({
				type: "command_error",
				command: "prompt",
				requestId: firstHandle.requestId,
				error: "first failed",
				isSettled: false,
			}),
		);
		clientInternals.handleLine(
			JSON.stringify({
				type: "agent_end",
				requestId: secondHandle.requestId,
				messages: [],
			}),
		);

		await expect(firstIdlePromise).rejects.toThrow("first failed");
		await expect(secondIdlePromise).resolves.toBeUndefined();
	});

	it("request-scoped failures stay terminal after a late agent_end", async () => {
		const client = new RpcClient();
		const clientInternals = client as unknown as {
			handleLine: (line: string) => void;
			send: (command: { type: string; message?: string }) => Promise<unknown>;
			isSettledState: boolean;
		};
		clientInternals.isSettledState = true;
		clientInternals.send = async () => {
			return {
				id: "req_prompt",
				type: "response",
				command: "prompt",
				success: true,
				data: { accepted: true, isSettled: false },
			};
		};

		const handle = await client.prompt("hello");
		const initialIdlePromise = client.waitForIdle(handle, 500);

		clientInternals.handleLine(
			JSON.stringify({
				type: "command_error",
				command: "prompt",
				requestId: handle.requestId,
				error: "prompt failed",
				isSettled: false,
			}),
		);
		await expect(initialIdlePromise).rejects.toThrow("prompt failed");

		clientInternals.handleLine(
			JSON.stringify({
				type: "agent_end",
				requestId: handle.requestId,
				messages: [],
			}),
		);

		await expect(client.waitForIdle(handle, 500)).rejects.toThrow("prompt failed");
		await expect(client.collectEvents(handle, 500)).rejects.toThrow("prompt failed");
	});

	it("promptAndWait rejects when command_error arrives before the accepted response is processed", async () => {
		const client = new RpcClient();
		let pendingRequestId = "";
		const clientInternals = client as unknown as {
			handleLine: (line: string) => void;
			send: (command: { type: string; message?: string }, requestId?: string) => Promise<unknown>;
			isSettledState: boolean;
		};
		clientInternals.isSettledState = true;
		clientInternals.send = async (_command, requestId) => {
			pendingRequestId = requestId ?? "";
			await wait(40);
			return {
				id: pendingRequestId,
				type: "response",
				command: "prompt",
				success: true,
				data: { accepted: true, isSettled: false, hasLifecycle: true },
			};
		};

		const promptPromise = client.promptAndWait("hello", undefined, 500);
		await wait(10);
		clientInternals.handleLine(
			JSON.stringify({
				type: "command_error",
				command: "prompt",
				requestId: pendingRequestId,
				error: "prompt failed",
				isSettled: true,
			}),
		);

		await expect(promptPromise).rejects.toThrow("prompt failed");
	});

	it("request-scoped waiters resolve immediately for accepted commands without a lifecycle", async () => {
		const client = new RpcClient();
		const clientInternals = client as unknown as {
			send: (command: { type: string; message?: string }, requestId?: string) => Promise<unknown>;
			isSettledState: boolean;
		};
		clientInternals.isSettledState = true;
		clientInternals.send = async (_command, requestId) => {
			return {
				id: requestId,
				type: "response",
				command: "follow_up",
				success: true,
				data: { accepted: true, isSettled: true, hasLifecycle: false },
			};
		};

		const handle = await client.followUp("hello");

		await expect(client.waitForIdle(handle, 500)).resolves.toBeUndefined();
		await expect(client.collectEvents(handle, 500)).resolves.toEqual([]);
	});
});
