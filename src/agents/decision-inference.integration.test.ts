import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionProviderContextV2 } from "../decisions/provider-context.js";
import type { DecisionRuntimeV2 } from "../decisions/types-v2.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  assertProviderAuthAuthority,
  getProviderAuthAuthority,
} from "../plugins/provider-auth-authority.js";
import { getPluginRuntimeGenerationRegistry } from "../plugins/runtime/generation-state.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { executePreparedDecision } from "./decision-inference.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const traceKey = Symbol.for("openclaw.test.decision-prepared-path");
let profileState: OpenClawTestState | undefined;
type Trace = {
  calls: number;
  onDispatch?: () => void;
  beforeRequest?: (context: DecisionProviderContextV2) => void;
  fetch?: typeof fetch;
  work?: Promise<void>;
  authenticated: boolean;
  modelKeys?: string[];
  profileId?: string;
  agentId?: string;
  modelContextWindow?: number;
  resultReads?: number;
  modelBilling?: unknown;
  modelBaseUrl?: string;
  modelHeaders?: Record<string, string>;
  modelRequest?: unknown;
  modelApi?: string;
  preparedApi?: string;
  evaluate?: DecisionRuntimeV2["evaluateV2"];
};
afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  Reflect.deleteProperty(globalThis, traceKey);
  await profileState?.cleanup();
  profileState = undefined;
});

it.each([
  "plugin",
  "agent",
  "profile",
  "missing",
  "exchange",
  "plugin-revoked-context",
  "plugin-revoked-model",
  "plugin-revoked-disabled",
] as const)(
  "runs the retained decision SDK through real preparation without primary fallback or fabricated chat fields (%s auth)",
  async (authScope) => {
    const pluginAuth = authScope.startsWith("plugin");
    const root = roots.make("decision-prepared-integration-");
    const pluginRoot = path.join(root, "plugin");
    const emptyBundled = path.join(root, "bundled");
    fs.mkdirSync(pluginRoot);
    fs.mkdirSync(emptyBundled);
    const id = "decision-prepared-fixture";
    const fixture = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId: id,
      providerId: id,
      manifest: {
        channels: [],
        channelConfigs: {},
        providerAuthChoices: [],
        contracts: { decisionProviders: [id] },
        modelCatalog: {
          providers: {
            [id]: {
              authScope: pluginAuth ? "plugin" : "agent",
              ...(pluginAuth
                ? {}
                : { api: "openai-completions", baseUrl: "https://catalog.fixture.invalid/v1" }),
              models: [
                {
                  id: "native",
                  name: "Native fixture",
                  ...(authScope === "exchange"
                    ? {
                        api: "openai-completions",
                        baseUrl: "https://catalog.fixture.invalid/v1",
                        contextWindow: 4096,
                        maxTokens: 256,
                      }
                    : {}),
                  inference: {
                    chat: authScope === "exchange",
                    decision: {
                      protocol: "fixture",
                      ...(authScope === "exchange"
                        ? { billing: { unit: "requests", source: "provider-catalog" } }
                        : {}),
                      input: ["text"],
                      questions: { boolean: { probabilities: "none", abstention: true } },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });
    fs.writeFileSync(
      fixture.runtimeSource,
      [
        'const trace = globalThis[Symbol.for("openclaw.test.decision-prepared-path")];',
        "module.exports = { id: " + JSON.stringify(id) + ", register(api) {",
        "api.registerDecisionProvider({ id: " + JSON.stringify(id) + ", contractVersion: 2,",
        'provider: { label: "Synthetic", auth: [], authScope: ' +
          JSON.stringify(pluginAuth ? "plugin" : "agent") +
          ", " +
          (authScope === "profile" || authScope === "missing"
            ? ""
            : 'resolveSyntheticAuth() { return {apiKey: "synthetic-prepared-token", mode: "api-key", source: "synthetic fixture"}; },') +
          (authScope === "agent" || authScope === "profile" || authScope === "missing"
            ? 'normalizeTransport() { return { api: "openai-responses" }; },'
            : "") +
          (authScope === "exchange"
            ? 'normalizeResolvedModel(context) { return { ...context.model, api: "openai-responses" }; }, prepareRuntimeAuth(context) { trace.preparedApi=context.model.api; return { apiKey: context.apiKey, baseUrl: "https://entitlement.fixture.invalid/v1", request: { headers: { "x-fixture-entitlement": "synthetic-entitlement" }, auth: { mode: "header", headerName: "x-fixture-auth", value: "synthetic-exchanged-header" } } }; },'
            : "") +
          "} ,",
        'async evaluate(batch, context) { trace.calls++; trace.profileId=context.auth.profileId; trace.agentId=context.agentId; trace.onDispatch?.(); await trace.work; trace.beforeRequest?.(context); if (!context.isAdmissible()) return { status: "unavailable", reason: "unsupported-input" }; await trace.fetch?.("https://dispatch.fixture.invalid/v1/decisions", { method: "POST" }); trace.authenticated = context.auth.apiKey === "synthetic-prepared-token"; trace.modelKeys = Object.keys(context.model); trace.modelContextWindow = context.model.contextWindow; trace.modelBilling=context.model.inference?.decision?.billing; trace.modelBaseUrl=context.model.baseUrl; trace.modelHeaders=context.model.headers; trace.modelRequest=context.model[Symbol.for("openclaw.modelProviderRequestTransport")]; trace.modelApi=context.model.api; let reads = 0; return { status: "ok", get result() { trace.resultReads = ++reads; return { model: context.model.id, answers: { q: reads === 1 ? { type: "boolean", answer: null } : { type: "boolean", probabilityTrue: 0.75 } }, usage: { inputTokens: 1, costUsd: 0.002 } }; } }; }',
        "}); trace.evaluate = api.runtime.decisions.evaluateV2; } };",
      ].join("\n"),
    );
    const trace: Trace = { calls: 0, authenticated: false };
    Reflect.set(globalThis, traceKey, trace);
    if (authScope === "profile") {
      profileState = await createOpenClawTestState({
        label: "decision-agent-profile",
        applyEnv: false,
      });
      // A synthetic key exists only in the operation agent store: no config/env credential.
      await profileState.writeAuthProfiles({
        version: 1,
        profiles: {
          [id + ":agent"]: { type: "api_key", provider: id, key: "synthetic-prepared-token" },
        },
      });
    }
    const cfg: OpenClawConfig = {
      ...(!pluginAuth
        ? {
            models: {
              providers: {
                [id]: {
                  api: "openai-completions",
                  baseUrl: "https://catalog.fixture.invalid/v1",
                  ...(authScope === "profile" || authScope === "missing"
                    ? {}
                    : { apiKey: "synthetic-prepared-token" }),
                  headers: { "x-provider": "provider", "X-Precedence": "provider" },
                  request: { headers: { "x-precedence": "request", "x-request": "request" } },
                  models: [
                    {
                      id: "native",
                      name: "Native fixture",
                      headers: { "x-model": "model", "X-PRECEDENCE": "model" },
                      ...(authScope === "exchange" ? { contextWindow: 4096 } : {}),
                      maxTokens: 256,
                      reasoning: false,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    },
                  ],
                },
              },
            },
          }
        : {}),
      agents: {
        defaults: {
          model: "unrelated/not-configured",
          decisionModel: id + "/native" + (authScope === "profile" ? "@" + id + ":agent" : ""),
          workspace: path.join(root, "workspace"),
        },
      },
      plugins: {
        load: { paths: [pluginRoot] },
        slots: { memory: "none" },
        entries: {
          [id]: { enabled: true, llm: { allowedCompletionModels: [id + "/native"] } },
        },
      },
    };
    const env = {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
      ...profileState?.envVars,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: profileState?.stateDir ?? path.join(root, "state"),
    };
    await withEnvAsync(env, async () => {
      setRuntimeConfigSnapshot(cfg);
      const registry = await loadAndActivateRootPluginRegistry({
        config: cfg,
        env,
        workspaceDir: path.join(root, "workspace"),
      });
      expect(registry.diagnostics.filter((item) => item.level === "error")).toEqual([]);
      expect(registry.providers.map((entry) => entry.provider.id)).toContain(id);
      const evaluate = trace.evaluate;
      expect(evaluate).toBeTypeOf("function");
      if (!evaluate) {
        throw new Error("Decision registration omitted its runtime capability");
      }
      const http = vi.fn<typeof fetch>(async () => new Response("{}"));
      let admitted = true;
      if (authScope.startsWith("plugin-revoked")) {
        trace.fetch = http;
        trace.beforeRequest = (context) => {
          expect(context.auth.apiKey).toBe("synthetic-prepared-token");
          expect(getProviderAuthAuthority(context.model)).toBeTypeOf("function");
          // Revoke the captured prepared owner; a replaced root registry cannot revoke retained work.
          const prepared = getPluginRuntimeGenerationRegistry();
          expect(prepared).toBeDefined();
          const provider = prepared!.providers.find((entry) => entry.provider.id === id)!.provider;
          provider.resolveSyntheticAuth = undefined;
          if (authScope === "plugin-revoked-disabled") {
            admitted = false;
          }
          if (authScope !== "plugin-revoked-context") {
            assertProviderAuthAuthority(context.model);
          }
        };
      }
      const invoke: DecisionRuntimeV2["evaluateV2"] =
        authScope === "plugin-revoked-disabled"
          ? async (batch, options) => {
              const provider = registry.decisionProviders[0]!.host.provider;
              if (provider.contractVersion !== 2) {
                throw new Error("Fixture requires prepared Decision execution");
              }
              const outcome = await executePreparedDecision({
                provider,
                batch,
                modelId: "native",
                registration: registry.providers.find((entry) => entry.provider.id === id)!,
                config: cfg,
                options,
                signal: options.signal,
                deadlineMonotonicMs: performance.now() + options.timeoutMs,
                isAdmissible: () => admitted,
              });
              if (outcome.status === "ok") {
                throw new Error("Revoked prepared admission unexpectedly returned a result");
              }
              return outcome;
            }
          : evaluate;
      const outcome = await invoke(
        {
          state: { type: "text", text: "synthetic evidence" },
          questions: { q: { type: "boolean" } },
        },
        {
          ...(authScope === "profile" ? { agentId: "main" } : {}),
          purpose: "fixture",
          rubricVersion: "v2",
          timeoutMs: 5000,
          signal: new AbortController().signal,
        },
      );
      if (authScope.startsWith("plugin-revoked")) {
        expect(outcome).toEqual({
          status: "unavailable",
          reason:
            authScope === "plugin-revoked-disabled"
              ? "unsupported-input"
              : "credentials-unavailable",
        });
        expect(trace.calls).toBe(1);
        expect(http).not.toHaveBeenCalled();
        expect(registry.decisionProviders[0]!.host.inspect(cfg).callable).toBe(true);
        return;
      }
      if (authScope === "missing") {
        expect(outcome).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
        expect(trace.calls).toBe(0);
        return;
      }
      expect(
        outcome,
        JSON.stringify({
          outcome,
          providerCalls: trace.calls,
        }),
      ).toMatchObject({
        status: "ok",
        result: { answers: { q: { answer: null } }, usage: { costUsd: 0.002 } },
      });
      expect(trace.calls).toBe(1);
      expect(trace.resultReads).toBe(1);
      expect(trace.authenticated).toBe(true);
      if (authScope === "profile") {
        expect(trace.profileId).toBe(id + ":agent");
        expect(trace.agentId).toBe("main");
      }
      if (authScope === "exchange") {
        expect(trace.modelBaseUrl).toBe("https://entitlement.fixture.invalid/v1");
        expect(trace.modelBilling).toBeUndefined();
        expect(trace.preparedApi).toBe("openai-responses");
        expect(trace.modelApi).toBe(trace.preparedApi);
        expect(trace.modelRequest).toMatchObject({
          headers: { "x-fixture-entitlement": "synthetic-entitlement" },
          auth: {
            mode: "header",
            headerName: "x-fixture-auth",
            value: "synthetic-exchanged-header",
          },
        });
        expect(trace.modelHeaders).toMatchObject({
          "x-fixture-entitlement": "synthetic-entitlement",
          "x-fixture-auth": "synthetic-exchanged-header",
        });
      } else {
        expect(trace.modelKeys).not.toContain("cost");
        expect(trace.modelKeys).not.toContain("maxTokens");
        expect(trace.modelContextWindow).toBeUndefined();
      }
      if (authScope === "agent" || authScope === "profile") {
        expect(trace.modelHeaders).toEqual({
          "x-provider": "provider",
          "x-model": "model",
          "x-precedence": "request",
          "x-request": "request",
        });
        expect(trace.modelRequest).toMatchObject({
          headers: { "x-precedence": "request", "x-request": "request" },
        });
        expect(trace.modelApi).toBe("openai-responses");
        setRuntimeConfigSnapshot({
          ...cfg,
          agents: {
            ...cfg.agents,
            defaults: {
              ...cfg.agents?.defaults,
              decisionModel: id + "/native@missing-fixture-profile",
            },
          },
        });
        await expect(
          evaluate(
            {
              state: { type: "text", text: "explicit profile" },
              questions: { q: { type: "boolean" } },
            },
            {
              purpose: "fixture",
              rubricVersion: "v2",
              timeoutMs: 5000,
              signal: new AbortController().signal,
            },
          ),
        ).resolves.toMatchObject({ status: "unavailable", reason: "credentials-unavailable" });
        expect(trace.calls).toBe(1);
        setRuntimeConfigSnapshot(cfg);
      }

      let started!: () => void;
      let finish!: () => void;
      const dispatched = new Promise<void>((resolve) => {
        started = resolve;
      });
      trace.work = new Promise<void>((resolve) => {
        finish = resolve;
      });
      trace.onDispatch = started;
      const controller = new AbortController();
      const pending = evaluate(
        {
          state: { type: "text", text: "synthetic cancellation" },
          questions: { q: { type: "boolean" } },
        },
        { purpose: "fixture", rubricVersion: "v2", timeoutMs: 5000, signal: controller.signal },
      );
      let settled = false;
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => {});
      await dispatched;
      controller.abort(new Error("fixture cancelled"));
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(registry.decisionProviders[0]!.host.inspect(cfg).activeRequests).toBe(1);
      finish();
      await expect(pending).rejects.toThrow("fixture cancelled");
      expect(registry.decisionProviders[0]!.host.inspect(cfg).activeRequests).toBe(0);
      await resetPreparedModelRuntimeSnapshotsForTest();
    });
  },
);
