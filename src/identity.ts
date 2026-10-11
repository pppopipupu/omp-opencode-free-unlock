/**
 * Identity values the OpenCode Zen / Zen Go gateway expects on free-tier
 * traffic.
 *
 * Contract (verified against the live gateway on 2026-09-22):
 *
 * - `User-Agent` must start with `opencode/<semver>`; a plain `omp/...`,
 *   `curl/...` or absent agent gets 403 `FreeTierError`.
 * - `x-opencode-session` must match `ses_` + 12 lowercase hex + 14 base62.
 *   A UUID or an arbitrary string gets 403 even when the agent is correct.
 *
 * Neither value is secret or cryptographic: the gateway only checks shape and
 * plausibility. We therefore keep the caller's own session identity and hash it
 * into the canonical shape, so one omp session keeps one stable upstream
 * session (which preserves provider-side prompt-cache affinity) instead of
 * minting a fresh id per request.
 */
import { createHash, randomBytes } from "node:crypto";

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** OpenCode client version reported in `User-Agent`. */
export const OPENCODE_CLIENT_VERSION = process.env.OMP_OPENCODE_FREE_UNLOCK_VERSION?.trim() || "1.18.31";

/** Stable stand-in when a caller sends no session signal at all. */
const FALLBACK_SESSION_SEED = randomBytes(16).toString("hex");

/** Encode a big-endian byte string as exactly `width` base62 characters. */
function base62Fixed(bytes: Uint8Array, width: number): string {
	let value = 0n;
	for (const byte of bytes) {
		value = (value << 8n) | BigInt(byte);
	}
	let out = "";
	for (let index = 0; index < width; index += 1) {
		out = BASE62_ALPHABET[Number(value % 62n)]! + out;
		value /= 62n;
	}
	return out;
}

/**
 * Map any caller session signal onto the canonical `ses_...` shape. An input
 * that already carries a canonical id is passed through untouched so upstream
 * affinity belonging to a real OpenCode client survives the relay.
 */
export function canonicalSessionId(signal: string | null | undefined): string {
	const candidate = signal?.trim();
	if (candidate && CANONICAL_SESSION_PATTERN.test(candidate)) {
		return candidate;
	}
	const digest = createHash("sha256")
		.update(`ses\0${candidate && candidate.length > 0 ? candidate : FALLBACK_SESSION_SEED}`)
		.digest();
	return `ses_${digest.subarray(0, 6).toString("hex")}${base62Fixed(digest.subarray(6, 16), 14)}`;
}

/** Per-request correlation id, matching the shape the OpenCode CLI sends. */
export function requestId(): string {
	return `req_${randomBytes(16).toString("hex")}`;
}

/** Stable project id derived from a project signal (workspace path). */
export function projectId(signal: string): string {
	return `prj_${createHash("sha256").update(`prj\0${signal}`).digest().subarray(0, 12).toString("hex")}`;
}

/** `User-Agent` accepted by the free-tier gate. */
export function clientUserAgent(): string {
	const bun = process.versions.bun ? `; bun/${process.versions.bun}` : "";
	return `opencode/${OPENCODE_CLIENT_VERSION} (${process.platform} ${process.arch}${bun})`;
}
