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
	assert.equal(promptFileForVariant("step-by-step"), "prompt_generation.txt");
	assert.equal(promptFileForVariant("one-shot"), "prompt_generation_one_shot.txt");
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
		extensionPath: "/repo/harness/pi_build123d_mcp.ts",
		imagePath: "/run/input.png",
		modelSpec: "qwen-token-plan-cn/qwen3.8-flash:high",
		piPath: "/pi/packages/coding-agent/dist/bundle/cli.js",
		providerExtensionPath: "/providers/pi-dashscope-native/src/index.ts",
	});

	assert.equal(invocation.command, "node");
	assert.deepEqual(invocation.args.slice(0, 2), ["/pi/packages/coding-agent/dist/bundle/cli.js", "--mode"]);
	assert.ok(invocation.args.includes("json"));
	assert.ok(invocation.args.includes("--no-session"));
	assert.ok(invocation.args.includes("--no-context-files"));
	assert.ok(invocation.args.includes("--no-extensions"));
	assert.ok(invocation.args.includes("--no-builtin-tools"));
	assert.ok(invocation.args.includes("--model"));
	assert.ok(invocation.args.includes("qwen-token-plan-cn/qwen3.8-flash"));
	assert.ok(invocation.args.includes("--thinking"));
	assert.ok(invocation.args.includes("high"));
		assert.ok(invocation.args.includes("/repo/harness/pi_build123d_mcp.ts"));
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
		assert.equal(await readFile(join(work, "input.png"), "utf8"), "png-bytes");
		assert.equal(await readFile(join(work, "prompt.txt"), "utf8"), prepared.prompt);
		assert.equal(prepared.outputPath, join(work, "output.step"));
		assert.ok(prepared.prompt.includes(join(work, "output.step")));
		await assert.rejects(() => access(join(work, "stream.jsonl")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("one-shot changes only the shared working-approach section", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-prompt-test-"));
	const fixture = join(root, "fixture");
	const work = join(root, "work");
	await mkdir(fixture, { recursive: true });
	await writeFile(join(fixture, "input.png"), "png-bytes");

	const step = await prepareWorkspace({ fixturePath: fixture, workPath: join(work, "step"), variant: "step-by-step" });
	const oneShot = await prepareWorkspace({ fixturePath: fixture, workPath: join(work, "one-shot"), variant: "one-shot" });
	try {
		const workingApproach = /## Working approach[\s\S]*?(?=\r?\n## Rules\r?\n)/;
		const stepSection = workingApproach.exec(step.prompt)?.[0] ?? "";
		const oneShotSection = workingApproach.exec(oneShot.prompt)?.[0] ?? "";
		const stepPrefix = step.prompt.slice(0, step.prompt.indexOf("## Working approach"));
		const oneShotPrefix = oneShot.prompt.slice(0, oneShot.prompt.indexOf("## Working approach"));
		const stepSuffix = step.prompt.slice(step.prompt.indexOf("\n## Rules"));
		const oneShotSuffix = oneShot.prompt.slice(oneShot.prompt.indexOf("\n## Rules"));

		assert.equal(oneShotPrefix, stepPrefix);
		assert.equal(
			oneShotSuffix.replaceAll(oneShot.outputPath, "{OUTPUT}").trimEnd(),
			stepSuffix.replaceAll(step.outputPath, "{OUTPUT}").trimEnd(),
		);
		assert.ok(oneShotSection.length >= stepSection.length * 0.45);
		assert.ok(step.prompt.includes("Build the side profile first, then the plan features."));
		assert.ok(!oneShot.prompt.includes("Build the side profile first, then the plan features."));
		assert.ok(oneShot.prompt.includes("Construct the complete part in the first execute()."));
		const numberedItem = (prompt, number) => {
			const start = prompt.indexOf(`\n${number}. **`);
			assert.ok(start !== -1, `missing numbered item ${number}`);
			const next = prompt.indexOf(`\n${number + 1}. **`, start);
			const end = next === -1 ? prompt.length : next;
			return prompt.slice(start, end).replaceAll("\r", "").trimEnd();
		};
		for (const sharedItem of [1, 3, 4, 5, 6]) {
			assert.equal(
				numberedItem(oneShotSection, sharedItem),
				numberedItem(stepSection, sharedItem),
				`one-shot item ${sharedItem} must preserve step-by-step guidance`,
			);
		}
		assert.ok(oneShot.prompt.includes('export("' + join(oneShot.workPath, "output.step") + '", format="step")'));
		assert.ok(oneShot.prompt.includes("## Priorities (resolve trade-offs in this order)"));
		assert.ok(oneShot.prompt.includes("## Rules"));
		assert.ok(oneShot.prompt.includes("## Tools"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
