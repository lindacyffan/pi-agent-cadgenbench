import assert from "node:assert/strict";
import test from "node:test";

import { convertMcpContent, createBuild123dMcpClient } from "./pi_build123d_mcp.ts";

test("converts MCP text and image content to Pi content", () => {
	const converted = convertMcpContent([
		{ type: "text", text: "rendered" },
		{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
	]);

	assert.deepEqual(converted, [
		{ type: "text", text: "rendered" },
		{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
	]);
});

test("bridges a persistent build123d MCP session", async () => {
	const client = createBuild123dMcpClient({
		mcpSpec: process.env.BUILD123D_MCP_TEST_SPEC ?? "build123d-mcp==0.3.81",
		execTimeoutSeconds: process.env.BUILD123D_MCP_TEST_EXEC_TIMEOUT ?? "300",
		requestTimeoutMs: Number(process.env.BUILD123D_MCP_TEST_REQUEST_TIMEOUT ?? "600000"),
	});

	try {
		await client.start();
		const tools = await client.listTools();
		const names = tools.map((tool) => tool.name);

		assert.ok(names.includes("execute"), "execute tool should be exposed");
		assert.ok(names.includes("render_view"), "render_view tool should be exposed");
		assert.ok(!names.includes("inspect_drawing"), "drawing tools should be disabled");

		const trivial = await client.callTool("execute", { code: "x = 1" });
		const trivialText = JSON.stringify(trivial.content);
		assert.ok(!trivialText.includes('"Error:'), trivialText);
		assert.equal(trivial.isError, false, trivialText);

		const executed = await client.callTool("execute", {
			code: "from build123d import Box\nshow(Box(1, 2, 3))",
		});
		const executedText = JSON.stringify(executed.content);
		assert.ok(!executedText.includes('"Error:'), executedText);
		assert.equal(executed.isError, false, JSON.stringify(executed.content));

		const state = await client.callTool("session_state", {});
		const stateText = JSON.stringify(state.content);
		assert.equal(state.isError, false, stateText);
		assert.ok(!stateText.includes('"Error:'), stateText);
		const stateContent = state.content[0];
		assert.equal(stateContent?.type, "text", stateText);
		if (stateContent?.type !== "text") throw new Error(stateText);
		const statePayload = JSON.parse(stateContent.text) as {
			current_shape?: { volume?: number; faces?: number };
			variables?: { x?: { value?: number } };
		};
		assert.equal(statePayload.current_shape?.volume, 6, stateText);
		assert.equal(statePayload.current_shape?.faces, 6, stateText);
		assert.equal(statePayload.variables?.x?.value, 1, stateText);
	} finally {
		await client.close();
	}
});
