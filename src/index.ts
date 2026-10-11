/**
 * omp-opencode-free-unlock.
 *
 * Since 2026-09-17 the OpenCode Zen free tier — and, since 2026-09-16, Zen Go
 * free models — reject any request that does not look like it came from the
 * official OpenCode client:
 *
 *   Error: 403 {"type":"FreeTierError","message":"...free tier can only be used
 *   from within OpenCode"}
 *
 * The gate inspects request headers and the request body:
 *
 *   1. `User-Agent` must start with `opencode/<semver>` (>= 1.17.0)
 *   2. `x-opencode-session` must be `ses_<12 hex><14 base62>`
 *   3. the body must declare agent tools (at least `bash` and `read`)
 *   4. the body must stream (`stream: true`)
 *
 * omp sends `User-Agent: omp/<version>` and its own UUIDv7 session id, so every
 * free-tier call fails 403. Neither is reachable from an extension through
 * provider configuration: `applyInferenceHeaders` force-sets the session field
 * after model headers are merged. The one seam that does work is
 * `globalThis.fetch`, which every inference request goes through — so this
 * extension installs an interceptor there and rewrites just those requests.
 *
 * Scope: requests to `https://opencode.ai/zen...` only. Header identity is
 * corrected for all of them; body shaping (tool completion, forced streaming
 * with SSE collapse) applies to free-tier models only, so paid traffic stays
 * byte-identical.
 *
 * This is client-identity mimicry against an upstream policy that explicitly
 * disallows third-party harnesses on the free tier. It is your call to make.
 * Disable by setting `OMP_OPENCODE_FREE_UNLOCK=0`, with `disabledExtensions`:
 * `extension-module:index`, or by removing the extension directory.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { installOpenCodeInterceptor, interceptorState } from "./interceptor.ts";

const TARGET_PROVIDERS = ["opencode-zen", "opencode-go"];

/**
 * Free Zen/Go models without `free` in the id. Every other zero-cost catalog
 * entry carries the marker, and the live model list tops this set up at session
 * start, but `big-pickle` (the default free Zen model) needs the explicit entry.
 */
const KNOWN_FREE_MODEL_IDS = ["big-pickle"];

export default function opencodeFreeUnlock(pi: ExtensionAPI) {
	pi.setLabel("OpenCode free unlock");
	if (process.env.OMP_OPENCODE_FREE_UNLOCK === "0") return;

	const state = interceptorState();
	for (const modelId of KNOWN_FREE_MODEL_IDS) state.freeModelIds.add(modelId);

	let installed: boolean;
	try {
		installed = installOpenCodeInterceptor();
	} catch (error) {
		console.error(`[opencode-free-unlock] fetch interceptor install failed: ${String(error)}`);
		return;
	}
	if (installed && process.env.OMP_OPENCODE_FREE_UNLOCK_DEBUG === "1") {
		console.error("[opencode-free-unlock] fetch interceptor installed for opencode.ai/zen traffic");
	}

	// The bundled catalog marks every free model at zero cost in both directions,
	// so this also catches free entries added after this extension was written.
	pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
		try {
			let free = 0;
			for (const model of ctx.models.list()) {
				if (!TARGET_PROVIDERS.includes(model.provider)) continue;
				if (model.cost?.input === 0 && model.cost?.output === 0) {
					state.freeModelIds.add(model.id);
					free += 1;
				}
			}
			if (process.env.OMP_OPENCODE_FREE_UNLOCK_DEBUG === "1") {
				const model = ctx.model;
				console.error(
					`[opencode-free-unlock] ${free} free ${TARGET_PROVIDERS.join("/")} models known;` +
						` session model=${model?.provider}/${model?.id} api=${model?.api}`,
				);
			}
		} catch (error) {
			console.error(`[opencode-free-unlock] free-model refresh failed: ${String(error)}`);
		}
	});
}
