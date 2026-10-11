import { describe, expect, test } from "bun:test";
import { canonicalSessionId, clientUserAgent, projectId, requestId } from "../src/identity.ts";

const CANONICAL = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

describe("canonicalSessionId", () => {
	test("maps a UUID session id onto the accepted shape", () => {
		const uuid = "01a0c611-f49f-7000-9000-abcdefabcdef";
		const session = canonicalSessionId(uuid);
		expect(CANONICAL.test(session)).toBe(true);
		expect(session).toHaveLength(4 + 12 + 14);
	});

	test("is stable per input and distinct across inputs", () => {
		expect(canonicalSessionId("session-a")).toBe(canonicalSessionId("session-a"));
		expect(canonicalSessionId("session-a")).not.toBe(canonicalSessionId("session-b"));
	});

	test("passes a real OpenCode session id through untouched", () => {
		const real = "ses_01a0c611f49fDhjJwU40DDl1F8";
		expect(canonicalSessionId(real)).toBe(real);
	});

	test("still produces a canonical id when the caller sends nothing", () => {
		expect(CANONICAL.test(canonicalSessionId(undefined))).toBe(true);
		expect(CANONICAL.test(canonicalSessionId(""))).toBe(true);
	});
});

describe("request and project ids", () => {
	test("request ids are unique and prefixed", () => {
		const first = requestId();
		expect(first).toMatch(/^req_[0-9a-f]{32}$/);
		expect(first).not.toBe(requestId());
	});

	test("project ids are stable per workspace path", () => {
		expect(projectId("/tmp/project")).toBe(projectId("/tmp/project"));
		expect(projectId("/tmp/project")).toMatch(/^prj_[0-9a-f]{24}$/);
		expect(projectId("/tmp/project")).not.toBe(projectId("/tmp/other"));
	});
});

describe("clientUserAgent", () => {
	test("starts with an OpenCode semver prefix the gate accepts", () => {
		expect(clientUserAgent()).toMatch(/^opencode\/1\.[0-9]+\.[0-9]+ \(/);
	});
});
