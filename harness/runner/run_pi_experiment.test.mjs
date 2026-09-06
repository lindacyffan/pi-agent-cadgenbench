import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	buildPiInvocation,
	parseModelSpec,
	prepareWorkspace,
	promptFileForVariant,
	renderPrompt,
} from "./run_pi_experiment.mjs";

test("maps each experimental variant to its prompt file", () => {
	assert.equal(promptFileForVariant("pi-agent"), "prompt_pi_agent.txt");
	assert.equal(promptFileForVariant("step-by-step"), "prompt_step_by_step.txt");
	assert.throws(() => promptFileForVariant("unknown"), /Unknown Pi experiment variant/);
});

test("substitutes the exact scored output path", () => {
	assert.equal(
		renderPrompt('export("{OUTPUT}", format="step")', "/tmp/run/output.step"),
		'export("/tmp/run/output.step", format="step")',
	);
});

test("parses optional Pi thinking suffix without breaking provider paths", () => {
	assert.deepEqual(parseModelSpec("qwen-token-plan-cn/qwen3.8-flash:high"), {
		model: "qwen-token-plan-cn/qwen3.8-flash",
		thinking: "high",
	});
	assert.deepEqual(parseModelSpec("zai-coding-cn/glm-5.3-flash"), {
		model: "zai-coding-cn/glm-5.3-flash",
		thinking: undefined,
	});
});

test("builds an isolated Pi-only JSON invocation", () => {
	const invocation = buildPiInvocation({
		extensionPath: "/repo/harness/bridge/pi_build123d_mcp.ts",
		imagePath: "/run/input.png",
		modelSpec: "qwen-token-plan-cn/qwen3.8-flash:high",
		piPath: "/pi/packages/coding-agent/dist/bundle/cli.js",
		providerExtensionPath: "/providers/pi-dashscope-native/src/index.ts",
	});

	assert.equal(invocation.command, "node");
	assert.deepEqual(invocation.args.slice(0, 2), [
		"/pi/packages/coding-agent/dist/bundle/cli.js",
		"--mode",
	]);
	assert.ok(invocation.args.includes("json"));
	assert.ok(invocation.args.includes("--no-session"));
	assert.ok(invocation.args.includes("--no-context-files"));
	assert.ok(invocation.args.includes("--no-extensions"));
	assert.ok(invocation.args.includes("--no-builtin-tools"));
	assert.ok(invocation.args.includes("--model"));
	assert.ok(invocation.args.includes("qwen-token-plan-cn/qwen3.8-flash"));
	assert.ok(invocation.args.includes("--thinking"));
	assert.ok(invocation.args.includes("high"));
	assert.ok(invocation.args.includes("/repo/harness/bridge/pi_build123d_mcp.ts"));
	assert.ok(invocation.args.includes("/providers/pi-dashscope-native/src/index.ts"));
	assert.equal(invocation.args.filter((arg) => arg === "--extension").length, 2);
	assert.ok(invocation.args.includes("@/run/input.png"));
	assert.equal(invocation.stdio[0], "pipe");
});

test("prepares an isolated fixture workspace without prior artifacts", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-experiment-test-"));
	const fixture = join(root, "fixture");
	const work = join(root, "work");
	await mkdir(fixture, { recursive: true });
	await mkdir(work, { recursive: true });
	await writeFile(join(fixture, "input.png"), "png-bytes");
	await writeFile(join(work, "output.step"), "stale");
	await writeFile(join(work, "stream.jsonl"), "stale");

	const prepared = await prepareWorkspace({ fixturePath: fixture, workPath: work });
	try {
		assert.equal(prepared.variant, "pi-agent");
		assert.equal(await readFile(join(work, "input.png"), "utf8"), "png-bytes");
		assert.equal(await readFile(join(work, "prompt.txt"), "utf8"), prepared.prompt);
		assert.equal(prepared.outputPath, join(work, "output.step"));
		assert.ok(prepared.prompt.includes(join(work, "output.step")));
		await assert.rejects(() => access(join(work, "stream.jsonl")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("uses separate complete working approaches with an identical prompt outside them", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-prompt-test-"));
	const fixture = join(root, "fixture");
	const work = join(root, "work");
	await mkdir(fixture, { recursive: true });
	await writeFile(join(fixture, "input.png"), "png-bytes");

	const baseline = await prepareWorkspace({
		fixturePath: fixture,
		workPath: join(work, "pi-agent"),
		variant: "pi-agent",
	});
	const step = await prepareWorkspace({
		fixturePath: fixture,
		workPath: join(work, "step-by-step"),
		variant: "step-by-step",
	});
	try {
		const normalize = (prompt, outputPath) => prompt.replaceAll(outputPath, "{OUTPUT}");
		const baselinePrompt = normalize(baseline.prompt, baseline.outputPath);
		const stepPrompt = normalize(step.prompt, step.outputPath);
		const workingApproach = /## Working approach[\s\S]*?(?=\r?\n## Tool use\r?\n)/;
		const baselineSection = workingApproach.exec(baselinePrompt)?.[0] ?? "";
		const stepSection = workingApproach.exec(stepPrompt)?.[0] ?? "";
		const baselinePrefix = baselinePrompt.slice(0, baselinePrompt.indexOf("## Working approach"));
		const stepPrefix = stepPrompt.slice(0, stepPrompt.indexOf("## Working approach"));
		const baselineSuffix = baselinePrompt.slice(baselinePrompt.indexOf("## Tool use"));
		const stepSuffix = stepPrompt.slice(stepPrompt.indexOf("## Tool use"));

		assert.equal(baselinePrefix, stepPrefix);
		assert.equal(baselineSuffix, stepSuffix);

		for (const prompt of [baseline.prompt, step.prompt]) {
			assert.ok(!prompt.includes("{{CONSTRUCTION_WORKFLOW}}"));
			assert.ok(!prompt.includes("## Construction policy"));
			assert.ok(!prompt.includes("## Shared workflow"));
			assert.ok(prompt.includes("## Priorities"));
			assert.ok(prompt.includes("## Working approach"));
			assert.ok(prompt.includes("save the first valid checkpoint"));
			assert.ok(prompt.includes('format="step"'));
			for (const forbiddenGuidance of [
				"Build a dimension table",
				"side profile first",
				"wall thickness",
				"dominant form",
				"build123d://skill",
				"arithmetic chain",
				"exactly two planned stages",
			]) {
				assert.ok(!prompt.includes(forbiddenGuidance), `prompt inherited forbidden guidance: ${forbiddenGuidance}`);
			}
		}

		for (const forbiddenGuidance of [
			"Treat construction as one-shot",
			"Use one geometry-changing `execute()` call",
		]) {
			assert.ok(!stepPrompt.includes(forbiddenGuidance), `step arm inherited one-shot guidance: ${forbiddenGuidance}`);
		}

		const workflowPatterns = [
			/Read `input\.png` and organize/,
			/Establish the main section, base, or primary structure/,
			/Add holes,[\s\S]*slots,[\s\S]*pockets,[\s\S]*bosses/,
			/Call `validate\(\)`/,
			/save the first valid checkpoint/,
			/render_view\(\)[\s\S]*measure\(\)[\s\S]*cross-section/,
			/largest remaining discrepancy[\s\S]*local correction/,
			/Validate the corrected model again/,
			/Export the final valid model/,
		];
		let searchAt = 0;
		for (const pattern of workflowPatterns) {
			const match = pattern.exec(stepPrompt.slice(searchAt));
			assert.ok(match, `step workflow lost stage: ${pattern}`);
			searchAt += match.index + match[0].length;
		}

		assert.match(baselinePrompt, /Treat construction as one-shot/);
		assert.match(
			baselinePrompt,
			/Use one geometry-changing `execute\(\)` call[\s\S]*construct the complete part/,
		);
		assert.doesNotMatch(baselinePrompt, /Establish the main section, base, or primary structure/);
		assert.equal(baselineSection.includes("semantic workflow"), stepSection.includes("semantic workflow"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
