#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "alibaba-qwen-dashscope-native/qwen3.8-flash:high";
const DEFAULT_MCP_SPEC = "build123d-mcp==0.3.81";
const DEFAULT_EXEC_TIMEOUT = "300";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PI_PATH = path.resolve(HERE, "../../pi/packages/coding-agent/dist/bundle/cli.js");
const DEFAULT_EXTENSION_PATH = path.join(HERE, "pi_build123d_mcp.ts");
const DEFAULT_PROVIDER_EXTENSION_PATH = path.join(
	homedir(),
	".pi",
	"agent",
	"git",
	"github.com",
	"Yiki21",
	"pi-dashscope-native",
	"src",
	"index.ts",
);

async function exists(filePath) {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

export function promptFileForVariant(variant) {
	if (variant === "pi-agent") return "prompt_construction_pi_agent.txt";
	if (variant === "step-by-step") return "prompt_construction_step_by_step.txt";
	throw new Error(`Unknown Pi experiment variant: ${variant}`);
}

export function renderPrompt(template, outputPath) {
	return template.replaceAll("{OUTPUT}", outputPath);
}

export function parseModelSpec(modelSpec) {
	const separator = modelSpec.lastIndexOf(":");
	if (separator === -1 || separator === 0 || separator === modelSpec.length - 1) {
		return { model: modelSpec, thinking: undefined };
	}
	return {
		model: modelSpec.slice(0, separator),
		thinking: modelSpec.slice(separator + 1),
	};
}

export function buildPiInvocation({ extensionPath, imagePath, modelSpec, piPath, providerExtensionPath }) {
	const { model, thinking } = parseModelSpec(modelSpec);
	const args = [
		piPath,
		"--mode",
		"json",
		"--no-session",
		"--no-context-files",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-builtin-tools",
		"--no-approve",
		"--extension",
		extensionPath,
		"--model",
		model,
	];
	if (providerExtensionPath) args.push("--extension", providerExtensionPath);
	if (thinking) args.push("--thinking", thinking);
	args.push(`@${imagePath}`);
	return { command: "node", args, stdio: ["pipe", "pipe", "pipe"] };
}

async function renderVariantPrompt(variant, outputPath) {
	const base = await readFile(path.join(HERE, "prompt_pi_agent_base.txt"), "utf8");
	const constructionPolicy = await readFile(path.join(HERE, promptFileForVariant(variant)), "utf8");
	const prompt = base.replace("{{CONSTRUCTION_POLICY}}", constructionPolicy.trimEnd());
	if (prompt === base) throw new Error("Could not substitute the construction policy");
	return renderPrompt(`${prompt.trimEnd()}\n`, outputPath);
}

export async function prepareWorkspace({ fixturePath, workPath, variant = "pi-agent" }) {
	const fixture = path.resolve(fixturePath);
	const work = path.resolve(workPath);
	const inputPath = path.join(fixture, "input.png");
	await access(inputPath);
	await mkdir(work, { recursive: true });

	const outputPath = path.join(work, "output.step");
	const streamPath = path.join(work, "stream.jsonl");
	const stderrPath = path.join(work, "pi.stderr.log");
	const promptPath = path.join(work, "prompt.txt");
	for (const stale of [outputPath, streamPath, stderrPath, path.join(work, "run_meta.json")]) {
		await rm(stale, { force: true });
	}
	await copyFile(inputPath, path.join(work, "input.png"));
	const prompt = await renderVariantPrompt(variant, outputPath);
	await writeFile(promptPath, prompt, "utf8");
	return { fixturePath: fixture, workPath: work, variant, prompt, outputPath, streamPath, stderrPath };
}

function parseCliArgs(argv) {
	const options = {
		variant: "pi-agent",
		model: DEFAULT_MODEL,
		mcpSpec: DEFAULT_MCP_SPEC,
		execTimeout: DEFAULT_EXEC_TIMEOUT,
		piPath: DEFAULT_PI_PATH,
		extensionPath: DEFAULT_EXTENSION_PATH,
		providerExtensionPath: DEFAULT_PROVIDER_EXTENSION_PATH,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const value = argv[i + 1];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			i += 1;
		} else if (arg === "--fixture") {
			options.fixture = value;
			i += 1;
		} else if (arg === "--work") {
			options.work = value;
			i += 1;
		} else if (arg === "--variant") {
			options.variant = value;
			i += 1;
		} else if (arg === "--model") {
			options.model = value;
			i += 1;
		} else if (arg === "--mcp-spec") {
			options.mcpSpec = value;
			i += 1;
		} else if (arg === "--exec-timeout") {
			options.execTimeout = value;
			i += 1;
		} else if (arg === "--pi") {
			options.piPath = path.resolve(value);
			i += 1;
		} else if (arg === "--extension") {
			options.extensionPath = path.resolve(value);
			i += 1;
		} else if (arg === "--provider-extension") {
			options.providerExtensionPath = path.resolve(value);
			i += 1;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return options;
}

const helpText = `Usage:
  node harness/run_pi_experiment.mjs --fixture <dir> --work <dir> [options]

Required:
  --fixture <dir>     CADGenBench generation fixture containing input.png
  --work <dir>        output directory for output.step, stream.jsonl, and metadata

Options:
  --variant <name>    pi-agent (default) or step-by-step
  --model <spec>      Pi model, optionally provider/model:thinking
  --mcp-spec <spec>   build123d-mcp version spec
  --exec-timeout <s>  build123d execute timeout
  --pi <path>         Pi CLI bundle path
  --extension <path>  Pi build123d extension path
  --provider-extension <path>
                      Pi model-provider extension path
`;

async function writeMetadata(filePath, metadata) {
	await writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function runExperiment(options) {
	const prepared = await prepareWorkspace({
		fixturePath: options.fixture,
		workPath: options.work,
		variant: options.variant,
	});
	const invocation = buildPiInvocation({
		extensionPath: options.extensionPath,
		imagePath: path.join(prepared.workPath, "input.png"),
		modelSpec: options.model,
		piPath: options.piPath,
		providerExtensionPath: options.providerExtensionPath,
	});
	const metadataPath = path.join(prepared.workPath, "run_meta.json");
	const startedAt = new Date().toISOString();
	const { model, thinking } = parseModelSpec(options.model);
	await writeMetadata(metadataPath, {
		benchmark: "HuggingAI4Engineering/cadgenbench-data",
		agent: "pi",
		variant: options.variant,
		model,
		thinking: thinking ?? null,
		piPath: options.piPath,
		extensionPath: options.extensionPath,
		providerExtensionPath: options.providerExtensionPath,
		mcpSpec: options.mcpSpec,
		execTimeoutSeconds: options.execTimeout,
		fixturePath: prepared.fixturePath,
		outputPath: prepared.outputPath,
		startedAt,
	});

	console.log(`Pi experiment: ${options.variant}`);
	console.log(`fixture: ${prepared.fixturePath}`);
	console.log(`work:    ${prepared.workPath}`);
	console.log(`model:   ${options.model}`);
	console.log(`mcp:     ${options.mcpSpec} (execute timeout ${options.execTimeout}s)`);
	const child = spawn(invocation.command, invocation.args, {
		cwd: prepared.workPath,
		env: {
			...process.env,
			BUILD123D_MCP_SPEC: options.mcpSpec,
			BUILD123D_EXEC_TIMEOUT: options.execTimeout,
		},
		stdio: invocation.stdio,
		windowsHide: true,
	});
	const stdout = createWriteStream(prepared.streamPath, { encoding: "utf8" });
	const stderr = createWriteStream(prepared.stderrPath, { encoding: "utf8" });
	child.stdout.pipe(stdout);
	child.stderr.pipe(stderr);
	child.stdin.write(prepared.prompt);
	child.stdin.end();
	const exitCode = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	await Promise.all([
		new Promise((resolve, reject) => stdout.once("error", reject).close(resolve)),
		new Promise((resolve, reject) => stderr.once("error", reject).close(resolve)),
	]);
	const producedOutput = await exists(prepared.outputPath);
	await writeMetadata(metadataPath, {
		...(JSON.parse(await readFile(metadataPath, "utf8"))),
		finishedAt: new Date().toISOString(),
		piExitCode: exitCode,
		producedOutput,
	});
	console.log(producedOutput ? "output.step produced" : "NO output.step; inspect stream.jsonl and pi.stderr.log");
	return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseCliArgs(process.argv.slice(2));
		if (options.help || !options.fixture || !options.work) {
			console.log(helpText);
			process.exitCode = options.help ? 0 : 2;
		} else {
			process.exitCode = await runExperiment(options);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
