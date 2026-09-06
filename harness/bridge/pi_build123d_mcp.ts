import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface JsonRpcId {
	readonly jsonrpc: "2.0";
	readonly id: number;
}

interface JsonRpcRequest extends JsonRpcId {
	readonly method: string;
	readonly params?: unknown;
}

interface JsonRpcResponse extends JsonRpcId {
	readonly result?: unknown;
	readonly error?: {
		readonly code: number;
		readonly message: string;
		readonly data?: unknown;
	};
}

type JsonRpcIncomingMessage = JsonRpcResponse | {
	readonly jsonrpc: "2.0";
	readonly method: string;
	readonly params?: unknown;
	readonly id?: number | string;
};

export interface McpTextContent {
	type: "text";
	text: string;
}

export interface McpImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type McpContent = McpTextContent | McpImageContent | Record<string, unknown>;

export interface McpTool {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
	content: (McpTextContent | McpImageContent)[];
	isError: boolean;
	structuredContent?: unknown;
}

export interface Build123dMcpClientOptions {
	mcpSpec: string;
	execTimeoutSeconds?: string | number;
	startupTimeoutMs?: number;
	requestTimeoutMs?: number;
}

interface PendingRequest {
	resolve: (value: any) => void;
	reject: (error: Error) => void;
	timeout: NodeJS.Timeout;
}

const localBuild123dSource = fileURLToPath(
	new URL("../../../build123d-mcp/src", import.meta.url),
);

function jsonRpcNotification(method: string, params?: unknown): string {
	return JSON.stringify({ jsonrpc: "2.0", method, params });
}

export function convertMcpContent(content: readonly McpContent[]): (McpTextContent | McpImageContent)[] {
	return content.flatMap((item): (McpTextContent | McpImageContent)[] => {
		if (item.type === "text" && typeof item.text === "string") {
			return [{ type: "text", text: item.text }];
		}
		if (
			item.type === "image" &&
			typeof item.data === "string" &&
			typeof item.mimeType === "string"
		) {
			return [{ type: "image", data: item.data, mimeType: item.mimeType }];
		}
		return [{ type: "text", text: JSON.stringify(item) }];
	});
}

export class Build123dMcpClient {
	private readonly args: string[];
	private readonly startupTimeoutMs: number;
	private readonly requestTimeoutMs: number;
	private child?: ChildProcess;
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private startPromise?: Promise<void>;
	private closePromise?: Promise<void>;
	private stderrTail = "";
	private exitError?: string;

	constructor(options: Build123dMcpClientOptions) {
		if (!options.mcpSpec) throw new Error("A build123d-mcp spec is required");
		this.args = [
			"tool",
			"run",
			"--python",
			"3.12",
			options.mcpSpec,
			"--no-sandbox",
			"--disable-tool-groups",
			"drawing",
		];
		if (options.execTimeoutSeconds !== undefined && `${options.execTimeoutSeconds}` !== "") {
			this.args.push("--exec-timeout", `${options.execTimeoutSeconds}`);
		}
		this.startupTimeoutMs = options.startupTimeoutMs ?? 120_000;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 600_000;
	}

	async start(): Promise<void> {
		this.startPromise ??= this.doStart();
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		if (this.closePromise) throw new Error("build123d MCP client is closed");

		const child = spawn("uv", this.args, {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			env: {
				...process.env,
				PYTHONPATH: [localBuild123dSource, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
			},
		});
		this.child = child;
		child.stdout?.setEncoding("utf8");
		createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8_000);
		});
		child.stdin?.on("error", () => {
			// Exit handling below turns an unexpected EPIPE into a request error.
		});
		child.once("error", (error) => this.failPending(new Error(`uv failed: ${error.message}`)));
		child.once("exit", (code, signal) => {
			this.exitError = `build123d-mcp exited (code=${code}, signal=${signal})`;
			this.failPending(new Error(this.describeExit()));
		});

		const initialize = await this.request(
			"initialize",
			{
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: {
					name: "pi-cadgenbench-bridge",
					version: "0.1.0",
				},
			},
			this.startupTimeoutMs,
		);
		if (!initialize || typeof initialize !== "object" || !("serverInfo" in initialize)) {
			throw new Error("build123d-mcp returned an invalid initialize result");
		}
		this.notify("notifications/initialized");
	}

	async listTools(): Promise<McpTool[]> {
		await this.start();
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		do {
			const result = await this.request<{ tools?: McpTool[]; nextCursor?: string }>(
				"tools/list",
				cursor ? { cursor } : {},
			);
			tools.push(...(result.tools ?? []));
			cursor = result.nextCursor;
		} while (cursor);
		return tools;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
		await this.start();
		const result = await this.request<{
			content?: McpContent[];
			isError?: boolean;
			structuredContent?: unknown;
		}>("tools/call", { name, arguments: args });
		return {
			content: convertMcpContent(result.content ?? []),
			isError: result.isError === true,
			structuredContent: result.structuredContent,
		};
	}

	async close(): Promise<void> {
		this.closePromise ??= this.doClose();
		return this.closePromise;
	}

	private async doClose(): Promise<void> {
		const child = this.child;
		this.exitError ??= "build123d MCP client closed";
		this.failPending(new Error(this.describeExit()));
		if (!child || child.exitCode !== null || child.signalCode !== null) return;

		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.stdin?.end();
		const timer = setTimeout(() => child.kill(), 3_000);
		timer.unref?.();
		await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 4_000))]);
	}

	private request<T = unknown>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
		const child = this.child;
		if (!child?.stdin?.writable) {
			return Promise.reject(new Error(this.describeExit()));
		}

		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out after ${timeoutMs}ms\n${this.describeExit()}`));
			}, timeoutMs);
			timeout.unref?.();
			this.pending.set(id, {
				resolve,
				reject,
				timeout,
			});
			child.stdin?.write(`${payload}\n`, (error) => {
				if (!error) return;
				this.pending.delete(id);
				clearTimeout(timeout);
				reject(new Error(`failed to send ${method}: ${error.message}`));
			});
		});
	}

	private notify(method: string, params?: unknown): void {
		if (!this.child?.stdin?.writable) throw new Error(this.describeExit());
		this.child.stdin.write(`${jsonRpcNotification(method, params)}\n`);
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let message: JsonRpcIncomingMessage;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}

		if ("id" in message && (typeof message.id === "number" || typeof message.id === "string")) {
			if (typeof message.id !== "number") return;
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timeout);
			if (message.error) {
				pending.reject(new Error(`${message.error.message} (${message.error.code})`));
			} else {
				pending.resolve(message.result);
			}
			return;
		}

		if (message.method === "ping") {
			this.sendResponseIfPossible(message.id, undefined);
		}
	}

	private sendResponseIfPossible(id: number | string | undefined, result: unknown): void {
		if (id === undefined || !this.child?.stdin?.writable) return;
		this.child.stdin.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id,
				result,
			})}\n`,
		);
	}

	private failPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private describeExit(): string {
		const stderr = this.stderrTail.trim();
		return [this.exitError ?? "build123d MCP transport is unavailable", stderr && `stderr:\n${stderr}`]
			.filter(Boolean)
			.join("\n");
	}
}

export function createBuild123dMcpClient(options: Build123dMcpClientOptions): Build123dMcpClient {
	return new Build123dMcpClient(options);
}

function piSchema(schema: Record<string, unknown>): any {
	return { ...schema, "~unsafe": null };
}

function registerTools(pi: ExtensionAPI, client: Build123dMcpClient, tools: readonly McpTool[]): void {
	for (const tool of tools) {
		pi.registerTool({
			name: tool.name,
			label: tool.name,
			description: tool.description ?? `Call build123d-mcp tool ${tool.name}.`,
			parameters: piSchema(tool.inputSchema),
			async execute(_toolCallId: string, params: Record<string, unknown>) {
				const result = await client.callTool(tool.name, params);
				return {
					content: result.content,
					details: result.structuredContent ?? {},
					isError: result.isError,
				};
			},
		} as any);
	}

	const active = pi.getActiveTools();
	pi.setActiveTools([...new Set([...active, ...tools.map((tool) => tool.name)])]);
}

export default function build123dMcpExtension(pi: ExtensionAPI): void {
	let client: Build123dMcpClient | undefined;

	async function startSessionTools(): Promise<void> {
		if (client) return;
		client = createBuild123dMcpClient({
			mcpSpec: process.env.BUILD123D_MCP_SPEC ?? "build123d-mcp==0.3.81",
			execTimeoutSeconds: process.env.BUILD123D_EXEC_TIMEOUT,
		});
		await client.start();
		const tools = await client.listTools();
		registerTools(pi, client, tools);
	}

	pi.on("session_start", async () => {
		await startSessionTools();
	});

	pi.on("session_shutdown", async () => {
		await client?.close();
		client = undefined;
	});
}
