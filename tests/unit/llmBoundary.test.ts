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

  it("without a server, a build with the flag off still says it is turned off (no network)", async () => {
    const fetchMock = vi.fn(async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { suggestMappings, LlmDisabledError, LlmError } = await import("../../src/llm/suggest");
    const err = await suggestMappings("k", project).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).not.toBeInstanceOf(LlmDisabledError);
    expect((err as Error).message).toContain("turned off");
  });
});
