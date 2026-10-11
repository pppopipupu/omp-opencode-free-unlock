import { afterEach, describe, expect, test } from "bun:test";
import {
	installOpenCodeInterceptor,
	interceptOpenCodeRequest,
	interceptorState,
	isOpenCodeGatewayUrl,
} from "../src/interceptor.ts";
import { CORE_TOOL_NAMES } from "../src/shape.ts";

const CHAT_URL = "https://opencode.ai/zen/v1/chat/completions";
const SESSION_UUID = "01a0c611-f49f-7000-9000-abcdefabcdef";

interface Call {
	url: string;
	init: RequestInit | undefined;
	body: Record<string, unknown> | undefined;
}

function stubFetch(response: () => Response): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const raw = init?.body;
		const text =
			typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : undefined;
		calls.push({
			url,
			init,
			body: text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>),
		});
		return response();
	}) as typeof fetch;
	return { fetch: stub, calls };
}

const sseResponse = () =>
	new Response(
		[
			'data: {"id":"c1","object":"chat.completion.chunk","created":5,"model":"mimo","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
			'data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":3}}',
			"data: [DONE]",
			"",
		].join("\n\n"),
		{ headers: { "content-type": "text/event-stream" } },
	);

const jsonResponse = () => Response.json({ id: "c1", object: "chat.completion", choices: [] });

const chatInit = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
	method: "POST",
	headers: {
		"content-type": "application/json",
		"user-agent": "omp/18.2.8",
		"x-opencode-session": SESSION_UUID,
		authorization: "Bearer key",
		...headers,
	},
	body: JSON.stringify(body),
});

const headerOf = (call: Call, name: string) => new Headers(call.init?.headers).get(name);

afterEach(() => {
	interceptorState().freeModelIds.clear();
});

describe("gateway matching", () => {
	test("matches Zen and Zen Go, ignores everything else", () => {
		expect(isOpenCodeGatewayUrl("https://opencode.ai/zen/v1/chat/completions")).toBe(true);
		expect(isOpenCodeGatewayUrl("https://opencode.ai/zen/go/v1/responses")).toBe(true);
		expect(isOpenCodeGatewayUrl("https://opencode.ai/auth")).toBe(false);
		expect(isOpenCodeGatewayUrl("https://models.opencode.ai/api.json")).toBe(false);
		expect(isOpenCodeGatewayUrl("https://example.com/zen/v1/chat/completions")).toBe(false);
	});

	test("forwards non-gateway requests untouched", async () => {
		const { fetch: stub, calls } = stubFetch(jsonResponse);
		const init = chatInit({ model: "mimo-v2.5-free" });
		const response = await interceptOpenCodeRequest("https://api.example.com/v1/chat/completions", init, stub);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(headerOf(calls[0]!, "user-agent")).toBe("omp/18.2.8");
		expect(calls[0]!.init?.body).toBe(init.body);
	});
});

describe("header correction", () => {
	test("replaces the agent and session while preserving auth and method", async () => {
		interceptorState().freeModelIds.add("mimo-v2.5-free");
		const { fetch: stub, calls } = stubFetch(jsonResponse);
		await interceptOpenCodeRequest(CHAT_URL, chatInit({ model: "mimo-v2.5-free", messages: [], stream: true }), stub);
		const call = calls[0]!;
		expect(call.url).toBe(CHAT_URL);
		expect(call.init?.method).toBe("POST");
		expect(headerOf(call, "user-agent")).toMatch(/^opencode\/1\./);
		expect(headerOf(call, "x-opencode-session")).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		expect(headerOf(call, "x-session-affinity")).toBe(headerOf(call, "x-opencode-session"));
		expect(headerOf(call, "x-opencode-client")).toBe("cli");
		expect(headerOf(call, "x-opencode-request")).toMatch(/^req_[0-9a-f]{32}$/);
		expect(headerOf(call, "x-opencode-project")).toMatch(/^prj_[0-9a-f]{24}$/);
		expect(headerOf(call, "authorization")).toBe("Bearer key");
		expect(headerOf(call, "content-type")).toBe("application/json");
	});

	test("keeps one upstream session per caller session", async () => {
		interceptorState().freeModelIds.add("mimo-v2.5-free");
		const { fetch: stub, calls } = stubFetch(jsonResponse);
		const body = { model: "mimo-v2.5-free", messages: [], stream: true };
		await interceptOpenCodeRequest(CHAT_URL, chatInit(body), stub);
		await interceptOpenCodeRequest(CHAT_URL, chatInit(body), stub);
		expect(headerOf(calls[1]!, "x-opencode-session")).toBe(headerOf(calls[0]!, "x-opencode-session"));
	});
});

describe("body shaping", () => {
	test("completes tool-less free-tier requests and forces streaming", async () => {
		interceptorState().freeModelIds.add("big-pickle");
		const { fetch: stub, calls } = stubFetch(sseResponse);
		const response = await interceptOpenCodeRequest(CHAT_URL, chatInit({ model: "big-pickle", messages: [] }), stub);
		const forwarded = calls[0]!.body!;
		expect(forwarded.stream).toBe(true);
		expect((forwarded.tools as { function: { name: string } }[]).map(tool => tool.function.name)).toEqual([
			...CORE_TOOL_NAMES,
		]);
		const collapsed = (await response.json()) as Record<string, unknown>;
		expect(collapsed.object).toBe("chat.completion");
		expect((collapsed.choices as { message: { content: string } }[])[0]!.message.content).toBe("ok");
		expect((collapsed.usage as Record<string, unknown>).total_tokens).toBe(3);
	});

	test("leaves a streaming free-tier request's body untouched", async () => {
		interceptorState().freeModelIds.add("big-pickle");
		const { fetch: stub, calls } = stubFetch(jsonResponse);
		const tools = CORE_TOOL_NAMES.map(name => ({ type: "function", function: { name, parameters: {} } }));
		const response = await interceptOpenCodeRequest(
			CHAT_URL,
			chatInit({ model: "big-pickle", messages: [], tools, stream: true }),
			stub,
		);
		expect(calls[0]!.init?.body).toBe(JSON.stringify({ model: "big-pickle", messages: [], tools, stream: true }));
		expect(response.headers.get("content-type")).toContain("application/json");
	});

	test("forwards paid models byte-identically", async () => {
		const { fetch: stub, calls } = stubFetch(jsonResponse);
		const body = { model: "claude-opus-4-8", messages: [], tools: [] };
		await interceptOpenCodeRequest("https://opencode.ai/zen/v1/messages", chatInit(body), stub);
		expect(calls[0]!.init?.body).toBe(JSON.stringify(body));
		expect(calls[0]!.url).toBe("https://opencode.ai/zen/v1/messages");
	});
});

describe("installation", () => {
	test("wraps globalThis.fetch once and reports later installs", async () => {
		const original = globalThis.fetch;
		const { fetch: stub, calls } = stubFetch(jsonResponse);
		globalThis.fetch = stub;
		try {
			expect(installOpenCodeInterceptor()).toBe(true);
			expect(globalThis.fetch).not.toBe(stub);
			expect(installOpenCodeInterceptor()).toBe(false);
			interceptorState().freeModelIds.add("mimo-v2.5-free");
			const response = await fetch(CHAT_URL, chatInit({ model: "mimo-v2.5-free", messages: [], stream: true }));
			expect(response.status).toBe(200);
			// The request left through the installed wrapper, not the bare stub.
			expect(calls[0]!.url).toBe(CHAT_URL);
			expect(headerOf(calls[0]!, "user-agent")).toMatch(/^opencode\//);
		} finally {
			globalThis.fetch = original;
		}
	});
});
