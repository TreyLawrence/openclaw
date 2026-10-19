import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { createReplyOperation } from "../../../sessions/session-controller.js";
import { getSessionControllerOperation } from "../../../sessions/session-controller.state.js";
import { testing } from "../../../sessions/session-controller.test-support.js";
import { drainGlobalSingletonLifecycleState } from "../../../shared/global-singleton.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { createSessionMaintenanceOwner } from "../../session-maintenance/coordinator.js";
import { detachActiveEmbeddedRun, attachActiveEmbeddedRun } from "../runs.js";
import { createEmbeddedRunHandle } from "../runs.test-support.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import { createLaneControllerFixture } from "./lane-controller.test-support.js";
import type { RunEmbeddedAgentParams } from "./params.js";

// mock-isolation: Execution-guard unit cases exercise raw custody without durable writer admission.
vi.mock("./session-bootstrap.js", () => ({
  claimAgentSessionWriter: vi.fn(async () => undefined),
}));

const key = "agent:main:controller-execution";
const globalLane = "test:controller-global";
function create(
  runId: string,
  enqueue?: CommandQueueEnqueueFn,
  overrides: Partial<RunEmbeddedAgentParams> = {},
) {
  const params: RunEmbeddedAgentParams & { sessionFile: string } = {
    admittedRunContext: createTestAdmittedRunContext(runId),
    sessionKey: key,
    sessionId: "incarnation",
    runId,
    sessionFile: "controller-execution.jsonl",
    workspaceDir: "/tmp/controller-execution",
    prompt: "test",
    timeoutMs: 60_000,
    trigger: "user",
    enqueue,
    ...overrides,
  };
  return createLaneControllerFixture(params, { globalLane, configureRuntime: false });
}
beforeEach(() => {
  setRuntimeConfigSnapshot({});
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});
afterEach(() => {
  testing.resetSessionControllerForTest();
  resetCommandQueueStateForTest();
  vi.useRealTimers();
  clearRuntimeConfigSnapshot();
});

describe("controller-owned execution guard", () => {
  it.each([
    {
      name: "same physical session",
      otherId: false,
      otherStore: false,
      detached: false,
      queued: true,
    },
    {
      name: "different session ID",
      otherId: true,
      otherStore: false,
      detached: false,
      queued: false,
    },
    { name: "different store", otherId: false, otherStore: true, detached: false, queued: false },
    {
      name: "explicit detached run",
      otherId: false,
      otherStore: false,
      detached: true,
      queued: false,
    },
  ])(
    "preserves sessionless admission for $name",
    async ({ otherId, otherStore, detached, queued }) => {
      const sessionId = "native-sessionless-owner";
      const storePath = "/synthetic/native-sessionless/sessions.sqlite";
      const first = create("native-sessionless-first", undefined, {
        sessionKey: undefined,
        sessionId,
        sessionFile: sessionId,
        sessionTarget: { storePath },
      });
      const entered = createDeferred();
      const finish = createDeferred();
      const order: string[] = [];
      const firstHandle = createEmbeddedRunHandle({ runId: "native-sessionless-first" });
      const predecessor = first.controller.enqueueSession(async () => {
        // Native registration keeps its keyless public identity while borrowing host admission.
        attachActiveEmbeddedRun(
          sessionId,
          firstHandle,
          undefined,
          sessionId,
          undefined,
          first.getParams().replyOperation,
        );
        try {
          expect(first.getParams().sessionKey).toBeUndefined();
          order.push("first");
          entered.resolve();
          await finish.promise;
          order.push("first settled");
        } finally {
          detachActiveEmbeddedRun(sessionId, firstHandle);
        }
      });
      await Promise.race([entered.promise, predecessor]);
      const second = create("native-sessionless-second", undefined, {
        sessionKey: undefined,
        sessionId: otherId ? "native-sessionless-other" : sessionId,
        sessionFile: otherId ? "native-sessionless-other" : sessionId,
        sessionTarget: {
          storePath: otherStore ? "/synthetic/native-sessionless-other/sessions.sqlite" : storePath,
        },
        ...(detached ? { sessionPersistence: "detached" } : {}),
      });
      const successor = second.controller.enqueueSession(async () => {
        expect(second.getParams().sessionKey).toBeUndefined();
        order.push("second");
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(queued ? ["first"] : ["first", "second"]);
        finish.resolve();
        await Promise.all([predecessor, successor]);
        expect(order).toEqual(
          queued ? ["first", "first settled", "second"] : ["first", "second", "first settled"],
        );
      } finally {
        finish.resolve();
        await Promise.allSettled([predecessor, successor]);
      }
    },
  );

  it("registers a keyless native attempt borrowed from a routable outer turn", async () => {
    const sessionId = "native-sessionless-borrowed";
    const operation = createReplyOperation({ sessionKey: key, sessionId, resetTriggered: false });
    const owned = create("native-sessionless-borrowed", undefined, {
      sessionKey: undefined,
      sessionId,
      sessionFile: sessionId,
      replyOperation: operation,
    });
    const handle = createEmbeddedRunHandle({ runId: "native-sessionless-borrowed" });
    try {
      await owned.controller.enqueueSession(async () => {
        attachActiveEmbeddedRun(sessionId, handle, undefined, sessionId, undefined, operation);
        expect(owned.getParams().sessionKey).toBeUndefined();
        detachActiveEmbeddedRun(sessionId, handle);
      });
      expect(operation.result).toBeNull();
    } finally {
      detachActiveEmbeddedRun(sessionId, handle);
      operation.complete();
      await operation.ownerSettlement;
    }
  });

  it("keeps a borrowed outer turn active when its nested caller cancels", async () => {
    const operation = createReplyOperation({
      sessionKey: key,
      sessionId: "incarnation",
      resetTriggered: false,
    });
    const caller = new AbortController();
    const { controller, getParams } = create("nested", undefined, {
      replyOperation: operation,
      abortSignal: caller.signal,
    });
    const entered = createDeferred();
    const finish = createDeferred();
    const nested = controller.enqueueSession(async () => {
      entered.resolve();
      await finish.promise;
      controller.throwIfAborted();
    });
    const reason = new Error("nested caller cancelled");
    const rejected = expect(nested).rejects.toBe(reason);
    try {
      await entered.promise;
      caller.abort(reason);
      expect(getParams().abortSignal?.reason).toBe(reason);
      expect(controller.abortSignal.reason).toBe(reason);
      expect(operation.abortSignal.aborted).toBe(false);
      expect(operation.result).toBeNull();
      expect(operation.watchdog.snapshot().phase).not.toBe("terminal");
      finish.resolve();
      await rejected;
      expect(getSessionControllerOperation(key)).toBe(operation);
      expect(operation.result).toBeNull();
    } finally {
      finish.resolve();
      await nested.catch(() => {});
      operation.complete();
    }
  });

  it("starts the preflight deadline after mailbox admission, not before its queue wait", async () => {
    const first = create("deadline-predecessor");
    const firstEntered = createDeferred();
    const firstFinish = createDeferred();
    const predecessor = first.controller.enqueueSession(async () => {
      firstEntered.resolve();
      await firstFinish.promise;
    });
    await firstEntered.promise;
    const second = create("deadline-successor");
    const secondEntered = createDeferred();
    const secondFinish = createDeferred();
    const successor = second.controller.enqueueSession(
      async () => {
        secondEntered.resolve();
        await secondFinish.promise;
        second.controller.throwIfAborted();
      },
      { taskTimeoutMs: 25 },
    );
    const outcome = successor.catch((error: unknown) => error);
    try {
      vi.setSystemTime(2_000);
      firstFinish.resolve();
      await predecessor;
      await secondEntered.promise;
      const operation = second.getParams().replyOperation;
      if (!operation) {
        throw new Error("Successor did not own a controller operation");
      }
      await operation.watchdog.tick();
      expect(second.controller.abortSignal.aborted).toBe(false);
      vi.setSystemTime(2_025);
      await operation.watchdog.tick();
      expect(second.controller.abortSignal.aborted).toBe(true);
    } finally {
      firstFinish.resolve();
      secondFinish.resolve();
      await Promise.allSettled([predecessor, outcome]);
    }
  });

  it.each([
    ["enqueueSession", "synchronous"],
    ["enqueueSession", "asynchronous"],
    ["enqueueGlobal", "synchronous"],
    ["enqueueGlobal", "asynchronous"],
  ] as const)(
    "passes run identity through %s with %s global capacity refusal",
    async (enqueueMethod, refusal) => {
      for (const trigger of ["user", "cron"] as const) {
        let observedOptions: Parameters<CommandQueueEnqueueFn>[1];
        const refused = new Error("queue admission refused");
        const { controller } = create(
          "child-run",
          (_task, options) => {
            observedOptions = options;
            if (refusal === "asynchronous") {
              return Promise.reject(refused);
            }
            throw refused;
          },
          {
            trigger,
            sessionKey: "agent:example:subagent:child",
            spawnedBy: "agent:example:main",
          },
        );
        const enterGlobal = () =>
          controller.enqueueGlobal(async () => ({ meta: { durationMs: 1 } }));

        await expect(async () =>
          enqueueMethod === "enqueueSession"
            ? await controller.enqueueSession(enterGlobal)
            : await enterGlobal(),
        ).rejects.toBe(refused);
        expect(observedOptions?.taskIdentity).toEqual({
          taskKind: trigger === "cron" ? "cron" : "spawn",
          sessionKey: "agent:example:subagent:child",
          runId: "child-run",
          requesterSessionKey: "agent:example:main",
        });
      }
    },
  );

  it("uses injected queues only for global capacity, never session admission or timeout races", async () => {
    const enqueue = vi.fn<(opts: Parameters<CommandQueueEnqueueFn>[1]) => void>();
    const { controller, getParams } = create("direct", async (task, opts) => {
      enqueue(opts);
      return await task();
    });
    await controller.enqueueSession(async () => {
      expect(enqueue).not.toHaveBeenCalled();
      expect(getSessionControllerOperation(key)).toBe(getParams().replyOperation);
      return controller.enqueueGlobal(async () => ({ meta: { durationMs: 1 } }));
    });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue.mock.calls[0]?.[0]).toMatchObject({
      taskIdentity: { runId: "direct", taskKind: "turn", sessionKey: key },
    });
    expect(enqueue.mock.calls[0]?.[0]?.taskTimeoutMs).toBeUndefined();
  });

  it("retains successor custody after the deadline until the raw producer settles", async () => {
    const first = create("first");
    const entered = createDeferred();
    const raw = createDeferred();
    const run = first.controller.enqueueSession(
      async () => {
        entered.resolve();
        await raw.promise;
        first.controller.throwIfAborted();
      },
      { taskTimeoutMs: 25 },
    );
    const failed = expect(run).rejects.toThrow();
    await entered.promise;
    const operation = first.getParams().replyOperation!;
    const dispatch = vi.fn(async () => "successor");
    const second = create("second").controller.enqueueSession(dispatch);
    vi.setSystemTime(1_025);
    await operation.watchdog.tick();
    expect(first.controller.abortSignal.aborted).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    expect(getSessionControllerOperation(key)).toBe(operation);
    let settled = false;
    void operation.ownerSettlement.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    raw.resolve();
    await failed;
    await expect(second).resolves.toBe("successor");
    expect(settled).toBe(true);
  });

  it("fences late preflight resumption before global admission without claiming timeout settlement", async () => {
    const { controller, getParams } = create("late-preflight");
    const entered = createDeferred();
    const gate = createDeferred();
    const execute = vi.fn(async () => ({ meta: { durationMs: 1 } }));
    const run = controller.enqueueSession(
      async () => {
        entered.resolve();
        await gate.promise;
        controller.throwIfAborted();
        return controller.enqueueGlobal(execute);
      },
      { taskTimeoutMs: 25 },
    );
    const failed = expect(run).rejects.toThrow();
    await entered.promise;
    vi.setSystemTime(1_025);
    await getParams().replyOperation!.watchdog.tick();
    expect(getCommandLaneSnapshot(globalLane).activeCount).toBe(0);
    gate.resolve();
    await failed;
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps a queued session alive while another session's stalled global producer settles", async () => {
    setCommandLaneConcurrency(globalLane, 1);
    const first = create("stalled-global-owner");
    const second = create("global-successor", undefined, {
      sessionKey: "agent:main:global-successor",
      sessionId: "global-successor",
      sessionFile: "global-successor.jsonl",
    });
    const entered = createDeferred();
    const raw = createDeferred();
    const queued = createDeferred();
    const stalled = first.controller.enqueueSession(() =>
      first.controller.enqueueGlobal(
        async () => {
          entered.resolve();
          await raw.promise;
          first.controller.throwIfAborted();
          return { meta: { durationMs: 1 } };
        },
        { taskTimeoutMs: 25 },
      ),
    );
    const failed = expect(stalled).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    await entered.promise;
    const successor = second.controller.enqueueSession(
      () =>
        second.controller.enqueueGlobal(async () => ({ meta: { durationMs: 1 } }), {
          onQueued: () => queued.resolve(),
        }),
      { taskTimeoutMs: 25 },
    );
    try {
      await queued.promise;
      vi.setSystemTime(1_024);
      await first.getParams().replyOperation!.watchdog.tick();
      await second.getParams().replyOperation!.watchdog.tick();
      expect(first.controller.abortSignal.aborted).toBe(false);
      expect(second.controller.abortSignal.aborted).toBe(false);
      expect(getCommandLaneSnapshot(globalLane)).toMatchObject({ activeCount: 1, queuedCount: 1 });

      vi.setSystemTime(1_025);
      await first.getParams().replyOperation!.watchdog.tick();
      await second.getParams().replyOperation!.watchdog.tick();
      expect(first.controller.abortSignal.aborted).toBe(true);
      expect(second.controller.abortSignal.aborted).toBe(false);
      // A deadline requests cancellation; raw settlement still owns global capacity.
      expect(getCommandLaneSnapshot(globalLane)).toMatchObject({ activeCount: 1, queuedCount: 1 });
      vi.setSystemTime(3_600_000);
      await second.getParams().replyOperation!.watchdog.tick();
      expect(second.controller.abortSignal.aborted).toBe(false);
      raw.resolve();
      await failed;
      await expect(successor).resolves.toEqual({ meta: { durationMs: 1 } });
      expect(second.controller.abortSignal.aborted).toBe(false);
      expect(getCommandLaneSnapshot(globalLane)).toMatchObject({ activeCount: 0, queuedCount: 0 });
    } finally {
      raw.resolve();
      await Promise.allSettled([stalled, successor]);
    }
  });

  it("does not let another queued global task shield an active stalled producer or release its capacity", async () => {
    const { controller, getParams } = create("parallel-capacity");
    const entered = createDeferred();
    const raw = createDeferred();
    const secondTask = vi.fn(async () => ({ meta: { durationMs: 2 } }));
    const run = controller.enqueueSession(async () => {
      const first = controller.enqueueGlobal(
        async () => {
          entered.resolve();
          await raw.promise;
          controller.throwIfAborted();
          return { meta: { durationMs: 1 } };
        },
        { taskTimeoutMs: 25 },
      );
      const second = controller.enqueueGlobal(secondTask);
      return await Promise.allSettled([first, second]);
    });
    await entered.promise;
    vi.setSystemTime(1_025);
    await getParams().replyOperation!.watchdog.tick();
    expect(getCommandLaneSnapshot(globalLane).activeCount).toBe(1);
    expect(secondTask).not.toHaveBeenCalled();
    raw.resolve();
    const outcomes = await run;
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(getCommandLaneSnapshot(globalLane).activeCount).toBe(0);
  });
});

describe("foreground cancellation before queue admission", () => {
  afterEach(async () => {
    await drainGlobalSingletonLifecycleState("close");
  });

  it.each(
    [false, true].flatMap((preemptible) =>
      ["error", "string"].map((reasonType) => ({ preemptible, reasonType })),
    ),
  )(
    "settles $reasonType Stop before held maintenance cleanup, preemptible=$preemptible",
    async ({ preemptible, reasonType }) => {
      const laneKey = `foreground-maintenance-${preemptible}`;
      const started = createDeferred();
      const cleanup = createDeferred();
      const owner = createSessionMaintenanceOwner({ sessionKey: laneKey, preemptible });
      let writerFinished = false;
      const work = owner.track(
        owner.run(async () => {
          started.resolve();
          await cleanup.promise;
          writerFinished = true;
        }),
      );
      await started.promise;
      const abort = new AbortController();
      const reason =
        reasonType === "error" ? new Error("foreground stopped") : "foreground stopped";
      let generation = getAgentEventLifecycleGeneration();
      let params: RunEmbeddedAgentParams & { sessionFile: string } = {
        abortSignal: abort.signal,
        lifecycleGeneration: generation,
        prompt: "hello",
        runId: laneKey,
        sessionFile: laneKey,
        sessionId: laneKey,
        sessionKey: laneKey,
        timeoutMs: 30_000,
        trigger: "user",
        workspaceDir: "/tmp",
      };
      const controller = createEmbeddedRunLaneController({
        getLifecycleGeneration: () => generation,
        getParams: () => params,
        globalLane: `${laneKey}-global`,
        initialQueuedLifecycleGeneration: generation,
        setLifecycleGeneration: (next) => {
          generation = next;
        },
        setParams: (next) => {
          params = next;
        },
      });
      let taskRan = false;
      let settled = false;
      const run = controller
        .enqueueSession(async () => {
          taskRan = true;
        })
        .then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      // Session-controller admission runs before the foreground reservation; Stop
      // must land while that reservation waits on the held maintenance writer.
      for (let turn = 0; turn < 50; turn += 1) {
        if (preemptible && owner.signal.aborted) {
          break;
        }
        await nextTurn();
      }
      abort.abort(reason);
      let beforeCleanup: { settled: boolean; writerFinished: boolean; taskRan: boolean };
      try {
        await nextTurn();
        beforeCleanup = { settled, writerFinished, taskRan };
        expect(getCommandLaneSnapshot(laneKey).queuedCount).toBe(0);
        expect(beforeCleanup.writerFinished).toBe(false);
        expect(beforeCleanup.taskRan).toBe(false);
        expect(owner.signal.aborted).toBe(preemptible);
        expect(
          beforeCleanup.settled,
          "Stop must settle independently of an unrelated writer's held cleanup",
        ).toBe(true);
      } finally {
        cleanup.resolve();
        await work;
        await run;
      }
      if (reason instanceof Error) {
        expect(await run).toBe(reason);
      } else {
        expect(await run).toMatchObject({ name: "AbortError", cause: reason });
      }
      expect(writerFinished).toBe(true);
      expect(taskRan).toBe(false);
      // A later optional owner must remain usable after the canceled caller drains.
      const successorAbort = new AbortController();
      const successor = createSessionMaintenanceOwner({
        sessionKey: laneKey,
        preemptible: true,
        abortSignal: successorAbort.signal,
      });
      let successorRan = false;
      const successorWork = successor.track(
        successor.run(async () => {
          successorRan = true;
        }),
      );
      try {
        await nextTurn();
        expect(successorRan).toBe(true);
      } finally {
        successorAbort.abort();
        await Promise.allSettled([successorWork]);
      }
    },
  );

  it("surfaces a non-abort admission failure even once the lane signal is aborted", async () => {
    const laneKey = "foreground-maintenance-real-failure";
    const abort = new AbortController();
    const failure = new Error("maintenance store unavailable");
    vi.resetModules();
    vi.doMock("../../session-maintenance/coordinator.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../session-maintenance/coordinator.js")>()),
      // Cancel first, so the lane's catch sees an aborted signal alongside a real failure.
      beginForegroundSessionMaintenance: async () => {
        abort.abort(new Error("user stopped"));
        throw failure;
      },
    }));
    try {
      const { createEmbeddedRunLaneController: createController } =
        await import("./lane-controller.js");
      let generation = getAgentEventLifecycleGeneration();
      let params: RunEmbeddedAgentParams & { sessionFile: string } = {
        abortSignal: abort.signal,
        lifecycleGeneration: generation,
        prompt: "hello",
        runId: laneKey,
        sessionFile: laneKey,
        sessionId: laneKey,
        sessionKey: laneKey,
        timeoutMs: 30_000,
        trigger: "user",
        workspaceDir: "/tmp",
      };
      const controller = createController({
        getLifecycleGeneration: () => generation,
        getParams: () => params,
        globalLane: `${laneKey}-global`,
        initialQueuedLifecycleGeneration: generation,
        setLifecycleGeneration: (next) => {
          generation = next;
        },
        setParams: (next) => {
          params = next;
        },
      });
      let taskRan = false;
      await expect(
        controller.enqueueSession(async () => {
          taskRan = true;
        }),
      ).rejects.toBe(failure);
      expect(taskRan).toBe(false);
    } finally {
      vi.doUnmock("../../session-maintenance/coordinator.js");
      vi.resetModules();
    }
  });
});
