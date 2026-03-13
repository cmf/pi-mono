import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.js";

let inputHandler: ((line: string) => void) | undefined;

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: (_stream: unknown, onLine: (line: string) => void) => {
		inputHandler = onLine;
		return () => {
			inputHandler = undefined;
		};
	},
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type RpcSessionEvent = { type: string; requestId?: string; messages?: unknown[] };

type SessionHarness = {
	session: AgentSession;
	emit: (event: RpcSessionEvent) => void;
	setSettled: (value: boolean) => void;
};

type SessionHarnessMethods = {
	prompt?: (message: string, options?: { source?: string; streamingBehavior?: string }) => Promise<void>;
	steer?: (message: string) => Promise<void>;
	followUp?: (message: string) => Promise<void>;
};

const waitForAsyncWork = async (): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const createSessionHarness = ({
	prompt = async () => {},
	steer = async () => {},
	followUp = async () => {},
}: SessionHarnessMethods): SessionHarness => {
	const listeners: Array<(event: RpcSessionEvent) => void> = [];
	const sessionState = { isSettled: true };

	const session = {
		get isSettled() {
			return sessionState.isSettled;
		},
		bindExtensions: vi.fn(async () => {}),
		subscribe: vi.fn((listener: (event: RpcSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index !== -1) {
					listeners.splice(index, 1);
				}
			};
		}),
		prompt: vi.fn(prompt),
		steer: vi.fn(steer),
		followUp: vi.fn(followUp),
		agent: { waitForIdle: vi.fn(async () => {}) },
		waitForSettled: vi.fn(async () => {}),
		newSession: vi.fn(async () => true),
		fork: vi.fn(async () => ({ cancelled: false })),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
		switchSession: vi.fn(async () => true),
		reload: vi.fn(async () => {}),
		modelRegistry: { getAvailable: vi.fn(async () => []) },
		promptTemplates: [],
		resourceLoader: { getSkills: () => ({ skills: [] }) },
		extensionRunner: undefined,
	} as unknown as AgentSession;

	return {
		session,
		emit: (event) => {
			for (const listener of [...listeners]) {
				listener(event);
			}
		},
		setSettled: (value) => {
			sessionState.isSettled = value;
		},
	};
};

describe("runRpcMode prompt responses", () => {
	let outputChunks: string[];

	beforeEach(() => {
		outputChunks = [];
		vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
			outputChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		inputHandler = undefined;
	});

	const getOutputs = (): Array<Record<string, unknown>> => {
		return outputChunks
			.flatMap((chunk) => chunk.split("\n"))
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	};

	it("returns a prompt error response when preflight validation fails", async () => {
		const harness = createSessionHarness({
			prompt: async () => {
				throw new Error("No model selected");
			},
		});
		void runRpcMode(harness.session);
		await waitForAsyncWork();

		inputHandler?.(JSON.stringify({ id: "req_1", type: "prompt", message: "hello" }));
		await waitForAsyncWork();

		expect(getOutputs()).toEqual([
			{
				id: "req_1",
				type: "response",
				command: "prompt",
				success: false,
				error: "No model selected",
			},
		]);
	});

	it("waits for agent_start before acknowledging a started prompt", async () => {
		let resolvePrompt: (() => void) | undefined;
		const harness = createSessionHarness({
			prompt: async () => {
				harness.setSettled(false);
				await new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				});
			},
		});
		void runRpcMode(harness.session);
		await waitForAsyncWork();

		inputHandler?.(JSON.stringify({ id: "req_2", type: "prompt", message: "hello" }));
		await waitForAsyncWork();
		expect(getOutputs()).toEqual([]);

		harness.emit({ type: "agent_start", messages: [] });
		await waitForAsyncWork();

		expect(getOutputs()).toEqual([
			{ type: "agent_start", requestId: "req_2", messages: [] },
			{
				id: "req_2",
				type: "response",
				command: "prompt",
				success: true,
				data: { accepted: true, isSettled: false, hasLifecycle: true },
			},
		]);

		resolvePrompt?.();
	});

	it("does not attach an idle follow_up request to a later prompt lifecycle", async () => {
		let resolvePrompt: (() => void) | undefined;
		const harness = createSessionHarness({
			followUp: async () => {},
			prompt: async () => {
				harness.setSettled(false);
				await new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				});
			},
		});
		void runRpcMode(harness.session);
		await waitForAsyncWork();

		inputHandler?.(JSON.stringify({ id: "req_follow_up", type: "follow_up", message: "later" }));
		await waitForAsyncWork();

		inputHandler?.(JSON.stringify({ id: "req_prompt", type: "prompt", message: "hello" }));
		await waitForAsyncWork();

		expect(getOutputs()).toEqual([
			{
				id: "req_follow_up",
				type: "response",
				command: "follow_up",
				success: true,
				data: { accepted: true, isSettled: true, hasLifecycle: false },
			},
		]);

		harness.emit({ type: "agent_start", messages: [] });
		await waitForAsyncWork();

		expect(getOutputs()).toEqual([
			{
				id: "req_follow_up",
				type: "response",
				command: "follow_up",
				success: true,
				data: { accepted: true, isSettled: true, hasLifecycle: false },
			},
			{ type: "agent_start", requestId: "req_prompt", messages: [] },
			{
				id: "req_prompt",
				type: "response",
				command: "prompt",
				success: true,
				data: { accepted: true, isSettled: false, hasLifecycle: true },
			},
		]);

		resolvePrompt?.();
	});
});
