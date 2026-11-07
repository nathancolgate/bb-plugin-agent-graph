// bb-plugin-agent-graph — frontend entry.
//
// Surfaces sharing one view: the "Agent Graph" sidebar page (every recent
// thread) with a right-panel "Thread" tab to chat beside the graph, and a
// thread side-panel tab (this thread or all threads) opened from a
// thread-header button.
import { useState } from "react";
import {
  definePluginApp,
  experimental_useAppPanel,
  experimental_useFixedTabTarget,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  experimental_useTabVisible,
  ThreadChat,
  useBbNavigate,
  type ExperimentalTabReference,
  type ExperimentalTabTargetReference,
} from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./contract";
import { AgentGraphView } from "./graph";
import { readStorage, writeStorage } from "./shared";
import { Button } from "@/components/ui/button";

const SCOPE_KEY = "agent-graph:panel-scope";
const BESIDE_KEY = "agent-graph:beside-thread";

type BesideTarget = { threadId: string };
/** The graph page's right-panel tab that hosts a thread's chat. */
const THREAD_TAB: ExperimentalTabTargetReference<BesideTarget> = {
  id: "thread",
  context: { kind: "nav-panel", panelId: "graph" },
  availability: "fixed",
  experimental_target: {
    validate: (value): value is BesideTarget =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { threadId?: unknown }).threadId === "string",
  },
};
/** The thread side-panel tab that shows the graph. */
const GRAPH_TAB: ExperimentalTabReference & { availability: "action" } = {
  id: "thread-graph",
  context: { kind: "thread" },
  availability: "action",
};

/**
 * The graph for one thread (or the overview). The server tags each read and
 * invalidates it when a thread it shows changes, so there is no polling.
 */
function useGraph(threadId: string | null, enabled = true) {
  const query = experimental_useRpcQuery({
    contract: rpcContract,
    method: "graph",
    input: { threadId },
    enabled,
  });
  return {
    graph: query.data ?? null,
    error: query.error?.message ?? null,
    retry: () => void query.refetch(),
  };
}

function OverviewPage() {
  const { graph, error, retry } = useGraph(null);
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  return (
    <div className="flex h-full min-h-0 flex-1">
      <AgentGraphView
        graph={graph}
        error={error}
        onRetry={retry}
        onOpenThread={(threadId) => navigate.toThread(threadId)}
        onOpenBeside={(threadId) => {
          writeStorage(BESIDE_KEY, threadId);
          panel.openTab({ tab: THREAD_TAB, target: { threadId } });
        }}
      />
    </div>
  );
}

const WORKING_INDICATORS = new Set([
  "runtime",
  "background-agent",
  "background-command",
  "workflow",
  "goal",
  "working-draft",
]);

/** Recent threads to pick from before any thread is followed. */
function ThreadPicker({ onPick }: { onPick: (threadId: string) => void }) {
  const { status, threads } = experimental_useSidebarThreads();
  const recent = [...threads]
    .filter((thread) => !thread.isArchived)
    .sort((a, b) => {
      const rank = (t: typeof a) =>
        t.hasPendingInteraction ? 0 : WORKING_INDICATORS.has(t.indicator) ? 1 : 2;
      return rank(a) - rank(b) || b.updatedAt - a.updatedAt;
    })
    .slice(0, 12);
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-4">
      <p className="text-sm text-muted-foreground">
        Pick a thread to chat with it here while you watch the graph. You can
        also double-click any node in the graph.
      </p>
      {status === "loading" ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading threads…</p>
      ) : (
        <ul className="mt-3 divide-y divide-border overflow-hidden rounded-lg border border-border">
          {recent.map((thread) => {
            const working = WORKING_INDICATORS.has(thread.indicator);
            return (
              <li key={thread.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-state-hover"
                  onClick={() => onPick(thread.id)}
                >
                  <span
                    aria-label={thread.indicatorLabel ?? undefined}
                    className={
                      "inline-block size-2 shrink-0 rounded-full " +
                      (thread.hasPendingInteraction
                        ? "bg-amber-500"
                        : working
                          ? "bg-blue-500"
                          : "bg-muted-foreground/30")
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {thread.title ?? thread.titleFallback ?? "Untitled thread"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Right-panel tab on the graph page: chat with the chosen thread. */
function BesideThreadTab() {
  const target = experimental_useFixedTabTarget(THREAD_TAB);
  const panel = experimental_useAppPanel();
  // Targets are memory-only; fall back to the last choice after a reload.
  const threadId = target?.target.threadId ?? readStorage(BESIDE_KEY);
  if (!threadId) {
    return (
      <ThreadPicker
        onPick={(id) => {
          writeStorage(BESIDE_KEY, id);
          panel.openTab({ tab: THREAD_TAB, target: { threadId: id } });
        }}
      />
    );
  }
  return <ThreadChat key={threadId} threadId={threadId} variant="compact" />;
}

type Scope = "thread" | "all";

function ScopeToggle({ scope, onChange }: { scope: Scope; onChange: (scope: Scope) => void }) {
  return (
    <div
      role="group"
      aria-label="Graph scope"
      className="flex items-center gap-0.5 rounded-lg border border-border bg-background/90 p-1 shadow-sm backdrop-blur"
    >
      {(["thread", "all"] as const).map((value) => (
        <Button
          key={value}
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          aria-pressed={scope === value}
          onClick={() => onChange(value)}
        >
          {value === "thread" ? "This thread" : "All threads"}
        </Button>
      ))}
    </div>
  );
}

function ThreadGraphPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const initial =
    (params as { scope?: Scope } | null)?.scope ??
    (readStorage(SCOPE_KEY) === "all" ? "all" : "thread");
  const [scope, setScope] = useState<Scope>(initial);
  // bb keeps a closed panel's tab mounted; only read while it is on screen.
  const visible = experimental_useTabVisible();
  const { graph, error, retry } = useGraph(
    scope === "all" ? null : threadId,
    visible,
  );
  const navigate = useBbNavigate();
  return (
    <div className="flex h-full min-h-0 flex-1">
      <AgentGraphView
        // Remount per scope so each view fits itself on first load.
        key={scope}
        graph={graph}
        error={error}
        onRetry={retry}
        compact
        toolbarExtra={
          <ScopeToggle
            scope={scope}
            onChange={(next) => {
              writeStorage(SCOPE_KEY, next);
              setScope(next);
            }}
          />
        }
        onOpenThread={(id) => {
          if (id !== threadId) navigate.toThread(id);
        }}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "graph",
    title: "Agent Graph",
    icon: "Workflow",
    path: "graph",
    component: OverviewPage,
  });
  app.slots.experimental_tab({
    ...THREAD_TAB,
    context: { kind: "nav-panel", panelId: "graph" },
    availability: "fixed",
    title: "Thread",
    icon: "MessageSquare",
    layout: "flush",
    component: BesideThreadTab,
  });
  app.slots.experimental_tab({
    ...GRAPH_TAB,
    context: { kind: "thread" },
    availability: "action",
    title: "Agent graph",
    icon: "Workflow",
    layout: "flush",
    component: ThreadGraphPanel,
    run: ({ experimental_panel }) => {
      experimental_panel.openTab({ tab: GRAPH_TAB, title: "Agent graph" });
    },
  });
  app.slots.experimental_threadAction({
    id: "graph-button",
    title: "Agent graph",
    icon: "Workflow",
    group: "agent-graph",
    placement: "header",
    item: ({ experimental_panel }) => ({
      label: "Agent graph",
      icon: "Workflow",
      run: () => {
        experimental_panel.openTab({ tab: GRAPH_TAB, title: "Agent graph" });
      },
    }),
  });
});
