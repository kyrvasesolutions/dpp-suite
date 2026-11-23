/**
 * The LLM boundary at runtime (C8-05, D8-05, T10): while the app is connected to the durable server, suggestMappings
 * refuses before any LLM code loads or any LLM host is contacted, even in a build with VITE_ENABLE_LLM=true.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../src/model/project";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const project = { left: { title: "L", rootId: "r", nodes: {} }, right: { title: "R", rootId: "r", nodes: {} }, mappings: [] } as unknown as Project;

function healthyServer() {
  return vi.fn(async (url: string | URL | Request) => {
    expect(String(url)).toBe("/api/health"); // the only request the refusal path may make: same origin
    return new Response(JSON.stringify({ status: "ok", schemaVersion: 6, activeRetentionPolicy: null }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("suggestMappings refuses in server mode", () => {
  it("throws LlmDisabledError with the LLM flag ON and a server answering", async () => {
    vi.stubEnv("VITE_ENABLE_LLM", "true");
    const fetchMock = healthyServer();
    vi.stubGlobal("fetch", fetchMock);
    const { suggestMappings, LlmDisabledError, LlmError, LLM_ENABLED } = await import("../../src/llm/suggest");
    expect(LLM_ENABLED).toBe(true);
    const err = await suggestMappings("sk-test", project).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmDisabledError);
    expect(err).toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws LlmDisabledError with the flag OFF too", async () => {
    vi.stubGlobal("fetch", healthyServer());
    const { suggestMappings, LlmDisabledError } = await import("../../src/llm/suggest");
    await expect(suggestMappings("k", project)).rejects.toBeInstanceOf(LlmDisabledError);
  });

  it("fails closed: an error, a 404, an HTML shell, a non-JSON body or a malformed health answer all refuse", async () => {
    const answers: Array<[string, () => Promise<Response>]> = [
      ["network error", async () => Promise.reject(new TypeError("Failed to fetch"))],
      ["404", async () => new Response("not found", { status: 404 })],
      ["500", async () => new Response("{}", { status: 500, headers: { "content-type": "application/json" } })],
      ["html shell", async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })],
      ["non-json body with a json type", async () => new Response("<<<", { status: 200, headers: { "content-type": "application/json" } })],
      ["malformed health", async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })],
      ["empty 204", async () => new Response(null, { status: 204 })],
    ];
    for (const [name, answer] of answers) {
      vi.resetModules();
      vi.stubEnv("VITE_ENABLE_LLM", "true");
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toBe("/api/health"); // never an LLM host
        return answer();
      });
      vi.stubGlobal("fetch", fetchMock);
      const { suggestMappings, LlmDisabledError } = await import("../../src/llm/suggest");
      await expect(suggestMappings("k", project), name).rejects.toBeInstanceOf(LlmDisabledError);
      expect(fetchMock, name).toHaveBeenCalledTimes(1);
    }
  });

  it("with no network API at all there is no server to protect, and the flag decides", async () => {
    vi.stubGlobal("fetch", undefined);
    const { suggestMappings, LlmDisabledError, LlmError } = await import("../../src/llm/suggest");
    const err = await suggestMappings("k", project).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).not.toBeInstanceOf(LlmDisabledError);
    expect((err as Error).message).toContain("turned off");
  });
});
