import { describe, expect, test } from "bun:test";
import { CORE_TOOL_NAMES, collapseSse, protocolForPath, shapeRequestBody } from "../src/shape.ts";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (value: Uint8Array) => JSON.parse(new TextDecoder().decode(value));
const freeOnly = (modelId: string | undefined) => modelId === "mimo-v2.5-free";
const toolNamesIn = (body: Record<string, unknown>, protocol: "chat" | "responses" | "messages") =>
	(body.tools as Record<string, unknown>[]).map(tool => {
		if (protocol === "chat") return (tool.function as Record<string, unknown>).name as string;
		return tool.name as string;
	});

describe("routing", () => {
	test("detects the protocol from the path", () => {
		expect(protocolForPath("/v1/chat/completions")).toBe("chat");
		expect(protocolForPath("/responses")).toBe("responses");
		expect(protocolForPath("/v1/messages")).toBe("messages");
		expect(protocolForPath("/v1/models")).toBeUndefined();
	});
});

describe("shapeRequestBody", () => {
	test("completes a tool-less free-tier chat request and forces streaming", () => {
		const result = shapeRequestBody("chat", encode({ model: "mimo-v2.5-free", messages: [] }), freeOnly);
		const body = decode(result.body) as Record<string, unknown>;
		expect(result.changed).toBe(true);
		expect(result.collapse).toBe("chat");
		expect(result.injectedTools).toEqual([...CORE_TOOL_NAMES]);
		expect(toolNamesIn(body, "chat")).toEqual([...CORE_TOOL_NAMES]);
		expect(body.stream).toBe(true);
		expect((body.stream_options as Record<string, unknown>).include_usage).toBe(true);
	});

	test("keeps declared tools and only appends the missing core names", () => {
		const declared = [{ type: "function", function: { name: "read", parameters: { type: "object" } } }];
		const result = shapeRequestBody(
			"chat",
			encode({ model: "big-pickle", tools: declared, stream: true }),
			modelId => modelId === "big-pickle",
		);
		const names = toolNamesIn(decode(result.body) as Record<string, unknown>, "chat");
		expect(names[0]).toBe("read");
		expect(names).toContain("bash");
		expect(result.collapse).toBeNull();
		expect(result.injectedTools).toEqual(["bash", "edit", "glob", "grep"]);
	});

	test("leaves a request that already satisfies the gate byte-identical", () => {
		const tools = CORE_TOOL_NAMES.map(name => ({ type: "function", function: { name, parameters: {} } }));
		const bytes = encode({ model: "mimo-v2.5-free", tools, stream: true });
		const result = shapeRequestBody("chat", bytes, freeOnly);
		expect(result.changed).toBe(false);
		expect(result.body).toBe(bytes);
	});

	test("does not touch paid models or unknown protocols", () => {
		const bytes = encode({ model: "claude-opus-4-8", messages: [], stream: false });
		const result = shapeRequestBody("chat", bytes, freeOnly);
		expect(result.changed).toBe(false);
		expect(result.body).toBe(bytes);
		expect(result.modelId).toBe("claude-opus-4-8");
	});

	test("shapes the Anthropic and Responses tool envelopes", () => {
		const messages = shapeRequestBody("messages", encode({ model: "mimo-v2.5-free", messages: [] }), freeOnly);
		const messagesBody = decode(messages.body) as Record<string, unknown>;
		expect(messagesBody.stream).toBe(true);
		expect(messages.collapse).toBe("messages");
		const first = (messagesBody.tools as Record<string, unknown>[])[0] as Record<string, unknown>;
		expect(Object.keys(first).sort()).toEqual(["description", "input_schema", "name"]);

		const responses = shapeRequestBody("responses", encode({ model: "mimo-v2.5-free", input: [], stream: true }), freeOnly);
		const responsesBody = decode(responses.body) as Record<string, unknown>;
		expect(responses.collapse).toBeNull();
		expect(toolNamesIn(responsesBody, "responses")).toEqual([...CORE_TOOL_NAMES]);
	});

	test("passes non-JSON bodies through untouched", () => {
		const bytes = new TextEncoder().encode("not json");
		const result = shapeRequestBody("chat", bytes, () => true);
		expect(result.changed).toBe(false);
		expect(result.body).toBe(bytes);
	});
});

describe("collapseSse", () => {
	test("rebuilds a chat completion from a stream, including tool calls and usage", () => {
		const sse = [
			'data: {"id":"chatcmpl_1","object":"chat.completion.chunk","created":7,"model":"mimo","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}',
			'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"content":"he"},"finish_reason":null}]}',
			'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"content":"llo"},"finish_reason":null}]}',
			'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"bash","arguments":"{\\"cmd\\":"}}]},"finish_reason":null}]}',
			'data: {"id":"chatcmpl_1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"ls\\"}"}}]},"finish_reason":"tool_calls"}]}',
			'data: {"id":"chatcmpl_1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}',
			"data: [DONE]",
			"",
		].join("\n\n");
		const collapsed = collapseSse("chat", sse) as Record<string, unknown>;
		const choice = (collapsed.choices as Record<string, unknown>[])[0] as Record<string, unknown>;
		const message = choice.message as Record<string, unknown>;
		expect(collapsed.object).toBe("chat.completion");
		expect(collapsed.created).toBe(7);
		expect(message.content).toBe("hello");
		expect(choice.finish_reason).toBe("tool_calls");
		expect((message.tool_calls as Record<string, unknown>[])[0]).toMatchObject({
			id: "call_1",
			function: { name: "bash", arguments: '{"cmd":"ls"}' },
		});
		expect((collapsed.usage as Record<string, unknown>).total_tokens).toBe(7);
	});

	test("rebuilds an Anthropic message from content block deltas", () => {
		const sse = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude","usage":{"input_tokens":9}}}',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
			"",
		].join("\n\n");
		const collapsed = collapseSse("messages", sse) as Record<string, unknown>;
		expect(collapsed.type).toBe("message");
		expect(collapsed.stop_reason).toBe("end_turn");
		expect((collapsed.usage as Record<string, unknown>).input_tokens).toBe(9);
		expect((collapsed.usage as Record<string, unknown>).output_tokens).toBe(2);
		expect((collapsed.content as Record<string, unknown>[])[0]).toMatchObject({ type: "text", text: "hi" });
	});

	test("returns the terminal Responses payload", () => {
		const sse = [
			'data: {"type":"response.output_text.delta","delta":"hi"}',
			'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}',
			"",
		].join("\n\n");
		expect(collapseSse("responses", sse)).toMatchObject({ id: "resp_1", status: "completed" });
	});
});
