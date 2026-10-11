/**
 * Fetch-level interception for OpenCode Zen / Zen Go traffic.
 *
 * omp has no extension seam for outbound provider headers: model headers are
 * merged first and `applyInferenceHeaders` then force-sets `x-opencode-session`
 * on every opencode request. Every inference call nevertheless funnels through
 * `globalThis.fetch` — `transportFetch` resolves it per request, and omp's own
 * `PROXY`/`PI_PROXY` support patches it the same way — so this module is the
 * one place where the final wire headers and body can be corrected.
 *
 * Only `https://opencode.ai/zen...` requests are touched; everything else is
 * forwarded to the previous fetch with the original arguments.
 */
import { canonicalSessionId, clientUserAgent, projectId, requestId } from "./identity.ts";
import { collapseSse, protocolForPath, shapeRequestBody, type Protocol } from "./shape.ts";

const GATEWAY_HOST = "opencode.ai";
const GATEWAY_PATH_PREFIX = "/zen";

/** Dropped from the outgoing request before ours are set. */
const REPLACED_REQUEST_HEADERS = [
	"content-length",
	"user-agent",
	"x-opencode-client",
	"x-opencode-session",
	"x-opencode-request",
	"x-opencode-project",
	"x-session-affinity",
	"x-session-id",
];

const PATCH_FLAG = Symbol.for("omp.opencode-free-unlock.patch");
const STATE_KEY = Symbol.for("omp.opencode-free-unlock.state");

export interface InterceptInfo {
	url: string;
	modelId: string | undefined;
	injectedTools: string[];
	collapsed: Protocol | null;
	status: number;
}

/**
 * Mutable state shared with the installed wrapper. Kept on `globalThis` so an
 * extension reload (F5) reuses the same object instead of stacking wrappers or
 * losing the learned free-model set.
 */
export interface InterceptorState {
	freeModelIds: Set<string>;
}

export function interceptorState(): InterceptorState {
	const holder = globalThis as unknown as Record<symbol, InterceptorState | undefined>;
	return (holder[STATE_KEY] ??= { freeModelIds: new Set<string>() });
}

/** True for the Zen and Zen Go gateway origins only. */
export function isOpenCodeGatewayUrl(rawUrl: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.hostname !== GATEWAY_HOST) return false;
	return url.pathname === GATEWAY_PATH_PREFIX || url.pathname.startsWith(`${GATEWAY_PATH_PREFIX}/`);
}

function requestUrlOf(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

async function bodyBytesOf(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
	const body = init?.body;
	if (typeof body === "string") return new TextEncoder().encode(body);
	if (body instanceof Uint8Array) return new Uint8Array(body);
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (body === undefined || body === null) {
		if (typeof Request !== "undefined" && input instanceof Request) {
			return new Uint8Array(await input.clone().arrayBuffer());
		}
		return undefined;
	}
	// Streams and form data are not shaped; the request is forwarded as-is.
	return undefined;
}

/** Debug mirror of one gateway request; the env is read at call time. */
function noteRequest(info: InterceptInfo): void {
	if (process.env.OMP_OPENCODE_FREE_UNLOCK_DEBUG !== "1") return;
	console.error(
		`[opencode-free-unlock] ${info.url} -> ${info.status} model=${info.modelId ?? "-"}` +
			` injected=${info.injectedTools.join(",") || "-"} collapsed=${info.collapsed ?? "-"}`,
	);
}

/**
 * Apply the header/body contract to one gateway request. `original` is whatever
 * fetch was installed before this plugin, so omp's proxy, CA and request-debug
 * layers keep working underneath.
 */
export async function interceptOpenCodeRequest(
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	original: typeof fetch,
): Promise<Response> {
	const rawUrl = requestUrlOf(input);
	if (!isOpenCodeGatewayUrl(rawUrl)) return original(input, init);

	const state = interceptorState();
	const url = new URL(rawUrl);
	const method = init?.method ?? (input instanceof Request ? input.method : "GET");
	const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
	// Read the caller's identity before the headers are replaced: omp sends its
	// own UUID session id here, and hashing it keeps one upstream session per
	// local session.
	const sessionSignal = headers.get("x-opencode-session");
	const projectSignal = headers.get("x-opencode-project");
	for (const name of REPLACED_REQUEST_HEADERS) headers.delete(name);
	headers.set("user-agent", clientUserAgent());
	if (!headers.has("accept")) headers.set("accept", "application/json, text/event-stream");
	headers.set("x-opencode-client", "cli");
	const session = canonicalSessionId(sessionSignal);
	headers.set("x-opencode-session", session);
	headers.set("x-session-affinity", session);
	headers.set("x-session-id", session);
	headers.set("x-opencode-request", requestId());
	headers.set("x-opencode-project", projectId(projectSignal ?? process.cwd()));

	const protocol = protocolForPath(url.pathname);
	let body: Uint8Array<ArrayBuffer> | undefined;
	let collapse: Protocol | null = null;
	let modelId: string | undefined;
	let injectedTools: string[] = [];
	let replacedBody = false;
	if (method !== "GET" && method !== "HEAD") {
		const raw = await bodyBytesOf(input, init);
		if (raw !== undefined) {
			const shaped = protocol
				? shapeRequestBody(protocol, raw, modelId2 => state.freeModelIds.has(modelId2 ?? "") || /free/i.test(modelId2 ?? ""))
				: { body: raw, changed: false, collapse: null, modelId: undefined, injectedTools: [] };
			body = shaped.body;
			collapse = shaped.collapse;
			modelId = shaped.modelId;
			injectedTools = shaped.injectedTools;
			// Unshaped bodies are forwarded exactly as the caller built them: no
			// re-encode, no extra copy, byte-identical paid traffic.
			replacedBody = shaped.changed || typeof init?.body !== "string";
		}
	}

	const forward: RequestInit = { ...init, method, headers };
	if (replacedBody) forward.body = body;
	const response = await original(url.href, forward);

	if (collapse && response.ok && (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
		const collapsed = collapseSse(collapse, await response.text());
		if (collapsed !== undefined) {
			noteRequest({ url: url.href, modelId, injectedTools, collapsed: collapse, status: response.status });
			return Response.json(collapsed, { status: response.status });
		}
	}

	noteRequest({ url: url.href, modelId, injectedTools, collapsed: null, status: response.status });
	return response;
}

/**
 * Install the interceptor on `globalThis.fetch`. Idempotent across extension
 * reloads: the wrapper is stamped on the global function, and all mutable state
 * lives in {@link interceptorState}, so a reload updates behaviour instead of
 * stacking another layer.
 */
export function installOpenCodeInterceptor(): boolean {
	const globalFetch = globalThis.fetch as typeof fetch & { [PATCH_FLAG]?: true };
	if (globalFetch[PATCH_FLAG]) return false;

	const original = globalFetch;
	const wrapped = ((input: RequestInfo | URL, init?: RequestInit) =>
		interceptOpenCodeRequest(input, init, original)) as typeof fetch & { [PATCH_FLAG]?: true };
	if (original.preconnect) wrapped.preconnect = original.preconnect;
	wrapped[PATCH_FLAG] = true;
	globalThis.fetch = wrapped;
	return true;
}
