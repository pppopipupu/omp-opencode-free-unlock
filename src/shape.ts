/**
 * Body shaping for the OpenCode Zen / Zen Go free tier.
 *
 * Contract (verified against the live gateway on 2026-09-22, independent
 * confirmation in jasonxu114514/opencode2api `anonymousCoreTools`):
 *
 * - the request must stream (`stream: true`); non-streaming gets 403
 * - the body must declare agent tools; a tool-less request gets 403 even with
 *   a correct `User-Agent` and `x-opencode-session`
 * - only tool *names* are inspected: `["bash","read"]` passes, `["bash"]`
 *   alone does not, and a bogus name such as `foo` does not either
 *
 * Shaping is applied to free-tier models only. Paid models keep their body
 * byte-identical, so nothing here can alter behaviour a caller already pays
 * for.
 */

export type Protocol = "chat" | "responses" | "messages";

/** Tool names the gateway accepts as an agent-shaped request. */
export const CORE_TOOL_NAMES = ["bash", "edit", "glob", "grep", "read"] as const;

const PLACEHOLDER_DESCRIPTION = "Reserved by the host; not callable.";

export function protocolForPath(pathname: string): Protocol | undefined {
	if (pathname.endsWith("/chat/completions")) return "chat";
	if (pathname.endsWith("/responses")) return "responses";
	if (pathname.endsWith("/messages")) return "messages";
	return undefined;
}

export interface ShapeResult {
	/** Body to forward upstream. */
	body: Uint8Array<ArrayBuffer>;
	/** Whether the body differs from the caller's bytes. */
	changed: boolean;
	/** Protocol to collapse back to JSON when the caller asked for non-streaming. */
	collapse: Protocol | null;
	modelId: string | undefined;
	injectedTools: string[];
}

function toolNames(protocol: Protocol, tools: unknown): Set<string> {
	const names = new Set<string>();
	if (!Array.isArray(tools)) return names;
	for (const entry of tools) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		if (protocol === "chat") {
			const fn = record.function;
			if (fn && typeof fn === "object" && typeof (fn as Record<string, unknown>).name === "string") {
				names.add((fn as Record<string, unknown>).name as string);
			}
			continue;
		}
		if (typeof record.name === "string") names.add(record.name);
	}
	return names;
}

function placeholderTool(protocol: Protocol, name: string): Record<string, unknown> {
	const parameters = { type: "object", properties: {} };
	if (protocol === "chat") {
		return { type: "function", function: { name, description: PLACEHOLDER_DESCRIPTION, parameters } };
	}
	if (protocol === "responses") {
		return { type: "function", name, description: PLACEHOLDER_DESCRIPTION, parameters };
	}
	return { name, description: PLACEHOLDER_DESCRIPTION, input_schema: parameters };
}

function unchanged(body: Uint8Array<ArrayBuffer>, modelId?: string): ShapeResult {
	return { body, changed: false, collapse: null, modelId, injectedTools: [] };
}

/**
 * Normalize a free-tier request body: keep declared tools, append placeholders
 * for the missing core names, and force streaming. Returns `changed: false`
 * (and the original bytes) for paid models, non-JSON bodies and payloads that
 * already satisfy the gate.
 */
export function shapeRequestBody(
	protocol: Protocol,
	bytes: Uint8Array<ArrayBuffer>,
	isFreeModel: (modelId: string | undefined) => boolean,
): ShapeResult {
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return unchanged(bytes);
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return unchanged(bytes);

	const record = payload as Record<string, unknown>;
	const modelId = typeof record.model === "string" ? record.model : undefined;
	if (!isFreeModel(modelId)) return unchanged(bytes, modelId);

	const declared = toolNames(protocol, record.tools);
	const injectedTools = CORE_TOOL_NAMES.filter(name => !declared.has(name));
	if (injectedTools.length > 0) {
		const tools = Array.isArray(record.tools) ? [...record.tools] : [];
		for (const name of injectedTools) tools.push(placeholderTool(protocol, name));
		record.tools = tools;
	}

	let collapse: Protocol | null = null;
	if (record.stream !== true) {
		record.stream = true;
		collapse = protocol;
		if (protocol === "chat") {
			// A forced SSE response only reports usage when asked; without this a
			// collapsed non-streaming reply would come back with no token counts.
			const options = record.stream_options;
			if (!options || typeof options !== "object") record.stream_options = { include_usage: true };
			else if ((options as Record<string, unknown>).include_usage === undefined) {
				(record.stream_options as Record<string, unknown>).include_usage = true;
			}
		}
	}

	if (injectedTools.length === 0 && collapse === null) return unchanged(bytes, modelId);
	return {
		body: new TextEncoder().encode(JSON.stringify(record)),
		changed: true,
		collapse,
		modelId,
		injectedTools,
	};
}

interface SseEvent {
	event: string | undefined;
	data: unknown;
}

function parseSse(text: string): SseEvent[] {
	const events: SseEvent[] = [];
	for (const block of text.split(/\r?\n\r?\n/)) {
		let event: string | undefined;
		const dataLines: string[] = [];
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith("event:")) event = line.slice(6).trim();
			else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
		}
		if (dataLines.length === 0) continue;
		const data = dataLines.join("\n");
		if (data === "[DONE]") {
			events.push({ event, data: "[DONE]" });
			continue;
		}
		try {
			events.push({ event, data: JSON.parse(data) });
		} catch {
			// Ignore keepalive comments and malformed frames.
		}
	}
	return events;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map(part => {
			if (typeof part === "string") return part;
			if (!part || typeof part !== "object") return "";
			const text = (part as Record<string, unknown>).text;
			return typeof text === "string" ? text : "";
		})
		.join("");
}

function collapseChat(events: SseEvent[]): unknown {
	const message: Record<string, unknown> = { role: "assistant", content: "" };
	const toolCalls: Record<string, unknown>[] = [];
	let id: string | undefined;
	let created: number | undefined;
	let model: string | undefined;
	let finishReason: unknown = null;
	let usage: unknown;

	for (const { data } of events) {
		if (!data || typeof data !== "object") continue;
		const chunk = data as Record<string, unknown>;
		if (typeof chunk.id === "string") id = chunk.id;
		if (typeof chunk.created === "number") created = chunk.created;
		if (typeof chunk.model === "string") model = chunk.model;
		if (chunk.usage) usage = chunk.usage;
		const choices = chunk.choices;
		if (!Array.isArray(choices)) continue;
		for (const choice of choices) {
			if (!choice || typeof choice !== "object") continue;
			const entry = choice as Record<string, unknown>;
			if (entry.finish_reason) finishReason = entry.finish_reason;
			const delta = entry.delta;
			if (!delta || typeof delta !== "object") continue;
			const record = delta as Record<string, unknown>;
			if (record.content !== undefined && record.content !== null) {
				message.content = `${(message.content as string) ?? ""}${textFromContent(record.content)}`;
			}
			const reasoning = record.reasoning_content ?? record.reasoning;
			if (typeof reasoning === "string" && reasoning.length > 0) {
				message.reasoning_content = `${(message.reasoning_content as string) ?? ""}${reasoning}`;
			}
			const calls = record.tool_calls;
			if (!Array.isArray(calls)) continue;
			for (const call of calls) {
				if (!call || typeof call !== "object") continue;
				const deltaCall = call as Record<string, unknown>;
				const index = typeof deltaCall.index === "number" ? deltaCall.index : toolCalls.length;
				const target = (toolCalls[index] ??= {
					index,
					id: "",
					type: "function",
					function: { name: "", arguments: "" },
				});
				const targetFunction = target.function as Record<string, unknown>;
				if (typeof deltaCall.id === "string") target.id = deltaCall.id;
				const fn = deltaCall.function;
				if (fn && typeof fn === "object") {
					const fnRecord = fn as Record<string, unknown>;
					if (typeof fnRecord.name === "string") targetFunction.name = fnRecord.name;
					if (typeof fnRecord.arguments === "string") {
						targetFunction.arguments = `${targetFunction.arguments as string}${fnRecord.arguments}`;
					}
				}
			}
		}
	}

	if (toolCalls.length > 0) message.tool_calls = toolCalls;
	const choice: Record<string, unknown> = { index: 0, message, finish_reason: finishReason };
	const result: Record<string, unknown> = {
		id: id ?? `chatcmpl_${Date.now()}`,
		object: "chat.completion",
		created: created ?? Math.floor(Date.now() / 1000),
		model: model ?? "",
		choices: [choice],
	};
	if (usage) result.usage = usage;
	return result;
}

function collapseMessages(events: SseEvent[]): unknown {
	const blocks: Record<string, unknown>[] = [];
	let id: string | undefined;
	let model: string | undefined;
	let stopReason: unknown = null;
	let stopSequence: unknown = null;
	let usage: Record<string, unknown> = {};

	for (const { data } of events) {
		if (!data || typeof data !== "object") continue;
		const event = data as Record<string, unknown>;
		const type = event.type;
		if (type === "message_start") {
			const message = event.message as Record<string, unknown> | undefined;
			if (message) {
				if (typeof message.id === "string") id = message.id;
				if (typeof message.model === "string") model = message.model;
				if (message.usage && typeof message.usage === "object") usage = { ...(message.usage as Record<string, unknown>) };
			}
			continue;
		}
		if (type === "content_block_start") {
			const index = typeof event.index === "number" ? event.index : blocks.length;
			const block = event.content_block;
			blocks[index] = block && typeof block === "object" ? { ...(block as Record<string, unknown>) } : { type: "text", text: "" };
			continue;
		}
		if (type === "content_block_delta") {
			const index = typeof event.index === "number" ? event.index : 0;
			const block = (blocks[index] ??= { type: "text", text: "" });
			const delta = event.delta as Record<string, unknown> | undefined;
			if (!delta) continue;
			if (typeof delta.text === "string") block.text = `${(block.text as string) ?? ""}${delta.text}`;
			if (typeof delta.thinking === "string") block.thinking = `${(block.thinking as string) ?? ""}${delta.thinking}`;
			if (typeof delta.signature === "string") block.signature = `${(block.signature as string) ?? ""}${delta.signature}`;
			if (typeof delta.partial_json === "string") {
				block.__partial = `${(block.__partial as string) ?? ""}${delta.partial_json}`;
			}
			continue;
		}
		if (type === "content_block_stop") {
			const index = typeof event.index === "number" ? event.index : 0;
			const block = blocks[index];
			if (block && typeof block.__partial === "string") {
				try {
					block.input = JSON.parse(block.__partial);
				} catch {
					block.input = {};
				}
				delete block.__partial;
			}
			continue;
		}
		if (type === "message_delta") {
			const delta = event.delta as Record<string, unknown> | undefined;
			if (delta) {
				if (delta.stop_reason !== undefined) stopReason = delta.stop_reason;
				if (delta.stop_sequence !== undefined) stopSequence = delta.stop_sequence;
			}
			if (event.usage && typeof event.usage === "object") usage = { ...usage, ...(event.usage as Record<string, unknown>) };
		}
	}

	return {
		id: id ?? `msg_${Date.now()}`,
		type: "message",
		role: "assistant",
		model: model ?? "",
		content: blocks.filter(Boolean),
		stop_reason: stopReason,
		stop_sequence: stopSequence,
		usage,
	};
}

function collapseResponses(events: SseEvent[]): unknown {
	let terminal: unknown;
	for (const { data } of events) {
		if (!data || typeof data !== "object") continue;
		const event = data as Record<string, unknown>;
		const type = event.type;
		if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
			terminal = event.response ?? event;
		}
	}
	return terminal;
}

/**
 * Convert a forced SSE stream back into the single JSON payload a
 * non-streaming caller expects. Returns `undefined` when the stream carried no
 * terminal frame, in which case the relay forwards the SSE bytes untouched.
 */
export function collapseSse(protocol: Protocol, text: string): unknown {
	const events = parseSse(text);
	if (protocol === "chat") return collapseChat(events);
	if (protocol === "responses") return collapseResponses(events);
	return collapseMessages(events);
}
