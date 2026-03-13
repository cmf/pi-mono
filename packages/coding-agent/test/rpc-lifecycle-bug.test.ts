import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
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
	abort?: () => Promise<void>;
	newSession?: () => Promise<boolean>;
	switchSession?: (sessionPath: string) => Promise<boolean>;
};

const waitForAsyncWork = async (): Promise<void> => {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const createSessionHarness = ({
	prompt = async () => {},
	abort = async () => {},
	newSession = async () => true,
	switchSession = async () => true,
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
		steer: vi.fn(async () => {}),
		followUp: vi.fn(async () => {}),
		abort: vi.fn(abort),
		waitForSettled: vi.fn(async () => {}),
		newSession: vi.fn(newSession),
		fork: vi.fn(async () => ({ cancelled: false })),
		navigateTree: vi.fn(async () => ({ cancelled: false })),
		switchSession: vi.fn(switchSession),
		reload: vi.fn(async () => {}),
		modelRegistry: { getAvailable: vi.fn(async () => []) },
		promptTemplates: [],
		resourceLoader: { getSkills: () => ({ skills: [] }) },
		extensionRunner: undefined,
		agent: { waitForIdle: vi.fn(async () => {}) },
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

describe("rpc lifecycle regressions", () => {
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

	it("rejects a prompt when the server responds with success:false", async () => {
		const client = new RpcClient();
		const clientInternals = client as unknown as {
			handleLine: (line: string) => void;
			process: { stdin: { write: (chunk: string) => boolean } };
		};
		clientInternals.process = {
			stdin: {
				write: vi.fn(() => true),
			},
		};

		const promptPromise = client.prompt("hello");
		await waitForAsyncWork();

		clientInternals.handleLine(
			JSON.stringify({
				id: "req_1",
				type: "response",
				command: "prompt",
				success: false,
				error: "server rejected prompt",
			}),
		);

		await expect(promptPromise).rejects.toThrow("server rejected prompt");
	});

	it.each([
		{
			name: "abort",
			command: { id: "req_reset", type: "abort" } as const,
			createMethods: (harness: { setSettled: (value: boolean) => void }): SessionHarnessMethods => ({
				prompt: async () => {
					harness.setSettled(false);
					await new Promise<void>(() => {});
				},
				abort: async () => {
					harness.setSettled(true);
				},
			}),
			response: { id: "req_reset", type: "response", command: "abort", success: true },
		},
		{
			name: "new_session",
			command: { id: "req_reset", type: "new_session" } as const,
			createMethods: (harness: { setSettled: (value: boolean) => void }): SessionHarnessMethods => ({
				prompt: async () => {
					harness.setSettled(false);
					await new Promise<void>(() => {});
				},
				newSession: async () => {
					harness.setSettled(true);
					return true;
				},
			}),
			response: {
				id: "req_reset",
				type: "response",
				command: "new_session",
				success: true,
				data: { cancelled: false },
			},
		},
		{
			name: "switch_session",
			command: { id: "req_reset", type: "switch_session", sessionPath: "/tmp/other.jsonl" } as const,
			createMethods: (harness: { setSettled: (value: boolean) => void }): SessionHarnessMethods => ({
				prompt: async () => {
					harness.setSettled(false);
					await new Promise<void>(() => {});
				},
				switchSession: async () => {
					harness.setSettled(true);
					return true;
				},
			}),
			response: {
				id: "req_reset",
				type: "response",
				command: "switch_session",
				success: true,
				data: { cancelled: false },
			},
		},
	])(
		"emits a terminal command_error when $name interrupts an accepted prompt",
		async ({ command, createMethods, response }) => {
			const harnessRef = { setSettled: (_value: boolean) => {} };
			const harness = createSessionHarness(createMethods(harnessRef));
			harnessRef.setSettled = harness.setSettled;

			void runRpcMode(harness.session);
			await waitForAsyncWork();

			inputHandler?.(JSON.stringify({ id: "req_prompt", type: "prompt", message: "hello" }));
			await waitForAsyncWork();
			expect(getOutputs()).toEqual([]);

			harness.emit({ type: "agent_start", messages: [] });
			await waitForAsyncWork();

			expect(getOutputs()).toEqual([
				{ type: "agent_start", requestId: "req_prompt", messages: [] },
				{
					id: "req_prompt",
					type: "response",
					command: "prompt",
					success: true,
					data: { accepted: true, isSettled: false, hasLifecycle: true },
				},
			]);

			inputHandler?.(JSON.stringify(command));
			await waitForAsyncWork();

			expect(getOutputs()).toEqual([
				{ type: "agent_start", requestId: "req_prompt", messages: [] },
				{
					id: "req_prompt",
					type: "response",
					command: "prompt",
					success: true,
					data: { accepted: true, isSettled: false, hasLifecycle: true },
				},
				{
					type: "command_error",
					command: "prompt",
					requestId: "req_prompt",
					error: `Request lifecycle was cancelled by ${command.type}`,
					isSettled: true,
				},
				response,
			]);
		},
	);

	it("stops correlating late agent_end events after a prompt invocation failure", async () => {
		let rejectPrompt!: (error: Error) => void;
		const harness = createSessionHarness({
			prompt: async () => {
				harness.setSettled(false);
				await new Promise<void>((_resolve, reject) => {
					rejectPrompt = reject as (error: Error) => void;
				});
			},
		});

		void runRpcMode(harness.session);
		await waitForAsyncWork();

		inputHandler?.(JSON.stringify({ id: "req_prompt", type: "prompt", message: "hello" }));
		await waitForAsyncWork();
		expect(getOutputs()).toEqual([]);

		harness.emit({ type: "agent_start", messages: [] });
		await waitForAsyncWork();

		rejectPrompt(new Error("prompt failed"));
		await waitForAsyncWork();

		expect(getOutputs()).toEqual([
			{ type: "agent_start", requestId: "req_prompt", messages: [] },
			{
				id: "req_prompt",
				type: "response",
				command: "prompt",
				success: true,
				data: { accepted: true, isSettled: false, hasLifecycle: true },
			},
			{
				type: "command_error",
				command: "prompt",
				requestId: "req_prompt",
				error: "prompt failed",
				isSettled: false,
			},
		]);

		harness.emit({ type: "agent_end", messages: [] });
		await waitForAsyncWork();

		expect(getOutputs()).toEqual([
			{ type: "agent_start", requestId: "req_prompt", messages: [] },
			{
				id: "req_prompt",
				type: "response",
				command: "prompt",
				success: true,
				data: { accepted: true, isSettled: false, hasLifecycle: true },
			},
			{
				type: "command_error",
				command: "prompt",
				requestId: "req_prompt",
				error: "prompt failed",
				isSettled: false,
			},
			{ type: "agent_end", messages: [] },
		]);
	});
});
