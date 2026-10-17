// bb-plugin-agent-graph — frontend entry.
//
// Surfaces sharing one view: the "Agent Graph" sidebar page (every recent
// thread) with a right-panel "Thread" tab to chat beside the graph, and a
// thread side-panel tab (this thread or all threads) opened from a
// thread-header button.
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  definePluginApp,
  experimental_useAppPanel,
  experimental_useFixedTabTarget,
  experimental_useSidebarThreads,
  ThreadChat,
  useBbNavigate,
  useRealtime,
  useRpc,
  type ExperimentalPluginFixedTabReference,
} from "@get-bb/plugin-sdk/app";
import type { Graph, rpcContract } from "./server";
import { AgentGraphView } from "./graph";
import { useSavedView, type SavedView } from "./saved-view";
import { normalizeFilter, type ThreadFilter } from "./filters";
import {
  GRAPH_CHANGED,
  readStorage,
  writeStorage,
  type GraphChangedPayload,
} from "./shared";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

const PANEL_ACTION_ID = "thread-graph";
const SCOPE_KEY = "agent-graph:panel-scope";
const BESIDE_KEY = "agent-graph:beside-thread";

type BesideTarget = { threadId: string };
/** The graph page's right-panel tab that hosts a thread's chat. */
const THREAD_TAB: ExperimentalPluginFixedTabReference<BesideTarget> = {
  panelId: "graph",
  id: "thread",
  experimental_target: {
    validate: (value): value is BesideTarget =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof (value as { threadId?: unknown }).threadId === "string",
  },
};

/**
 * The graph for one thread (or the overview), refetched on live changes.
 * `filter` hides overview threads; a new filter keeps the old graph on
 * screen until the new one arrives.
 */
function useGraph(threadId: string | null, filter: ThreadFilter = {}) {
  const rpc = useRpc<typeof rpcContract>();
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const graphRef = useRef<Graph | null>(null);
  const refetchRef = useRef<() => void>(() => {});
  const filterKey = JSON.stringify(normalizeFilter(filter));
  const shownThreadRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // Everything below belongs to this threadId and filter; a scope change
    // starts fresh, and late responses from the old scope are ignored.
    let cancelled = false;
    let inFlight = false;
    let again = false;
    if (shownThreadRef.current !== threadId) {
      shownThreadRef.current = threadId;
      graphRef.current = null;
      setGraph(null);
    }
    setError(null);
    const currentFilter = JSON.parse(filterKey) as ThreadFilter;

    const refetch = () => {
      // One request at a time; a change during a fetch schedules one more.
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      rpc
        .call("graph", threadId === null ? { threadId, filter: currentFilter } : { threadId })
        .then(
          (result) => {
            if (cancelled) return;
            graphRef.current = result;
            setGraph(result);
            setError(null);
          },
          (cause: unknown) => {
            if (cancelled) return;
            setError(cause instanceof Error ? cause.message : String(cause));
          },
        )
        .finally(() => {
          inFlight = false;
          if (again && !cancelled) {
            again = false;
            refetch();
          }
        });
    };
    refetchRef.current = refetch;
    refetch();

    // A slow heartbeat keeps durations and missed events honest, but only
    // while someone can see it.
    const timer = setInterval(() => {
      if (!document.hidden) refetch();
    }, 15_000);
    const onVisible = () => {
      if (!document.hidden) refetch();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [rpc, threadId, filterKey]);

  useRealtime(GRAPH_CHANGED, (payload: unknown) => {
    if (document.hidden) return;
    const current = graphRef.current;
    if (threadId !== null && current !== null) {
      // A single-thread graph only cares about threads it shows.
      const changed = (payload as Partial<GraphChangedPayload> | null)?.threadIds;
      const known = new Set(current.nodes.map((node) => node.threadId));
      if (changed && changed.length > 0 && !changed.some((id) => known.has(id))) return;
    }
    refetchRef.current();
  });

  return { graph, error, retry: () => refetchRef.current() };
}

/** The graph view before its saved state is known. */
function LoadingGraph({ toolbarExtra = null, compact = false }: { toolbarExtra?: ReactNode; compact?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-1">
      <AgentGraphView graph={null} error={null} onOpenThread={null} compact={compact} toolbarExtra={toolbarExtra} />
    </div>
  );
}

function OverviewPage() {
  const saved = useSavedView("overview");
  // The view reads its saved state, filter included, on mount; mount it
  // once that is known so the first fetch already uses the saved filter.
  return saved.ready ? <OverviewGraph saved={saved} /> : <LoadingGraph />;
}

function OverviewGraph({ saved }: { saved: SavedView }) {
  const [filter, setFilter] = useState<ThreadFilter>(() => saved.initial?.filter ?? {});
  const { graph, error, retry } = useGraph(null, filter);
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel();
  return (
    <div className="flex h-full min-h-0 flex-1">
      <AgentGraphView
        graph={graph}
        saved={saved}
        filter={filter}
        onFilterChange={setFilter}
        error={error}
        onRetry={retry}
        onOpenThread={(threadId) => navigate.toThread(threadId)}
        onOpenBeside={(threadId) => {
          writeStorage(BESIDE_KEY, threadId);
          panel.openFixedTab({
            surface: { kind: "current" },
            tab: THREAD_TAB,
            target: { threadId },
          });
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
          panel.openFixedTab({ surface: { kind: "current" }, tab: THREAD_TAB, target: { threadId: id } });
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
  // Each thread remembers its own view; a thread opened for the first time
  // starts with the settings the last thread panel was left in.
  const saved = useSavedView(
    scope === "all" ? "panel:all" : `thread:${threadId}`,
    scope === "all" ? null : "thread:last",
  );
  const toolbarExtra = (
    <ScopeToggle
      scope={scope}
      onChange={(next) => {
        writeStorage(SCOPE_KEY, next);
        setScope(next);
      }}
    />
  );
  if (!saved.ready) return <LoadingGraph toolbarExtra={toolbarExtra} compact />;
  return (
    <PanelGraph
      // Remount per scope so each view reads its own saved state and fits
      // itself on first load.
      key={scope}
      scope={scope}
      threadId={threadId}
      saved={saved}
      toolbarExtra={toolbarExtra}
    />
  );
}

function PanelGraph({
  scope,
  threadId,
  saved,
  toolbarExtra,
}: {
  scope: Scope;
  threadId: string;
  saved: SavedView;
  toolbarExtra: ReactNode;
}) {
  // Only "All threads" can be filtered; one thread's graph has nothing to hide.
  const [filter, setFilter] = useState<ThreadFilter>(() => saved.initial?.filter ?? {});
  const { graph, error, retry } = useGraph(scope === "all" ? null : threadId, filter);
  const navigate = useBbNavigate();
  return (
    <div className="flex h-full min-h-0 flex-1">
      <AgentGraphView
        graph={graph}
        saved={saved}
        filter={scope === "all" ? filter : null}
        onFilterChange={scope === "all" ? setFilter : null}
        error={error}
        onRetry={retry}
        compact
        toolbarExtra={toolbarExtra}
        onOpenThread={(id) => {
          if (id !== threadId) navigate.toThread(id);
        }}
      />
    </div>
  );
}

function ThreadHeaderButton() {
  const navigate = useBbNavigate();
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label="Open agent graph"
      onClick={() => {
        navigate.openThreadPanel({ actionId: PANEL_ACTION_ID, title: "Agent graph" });
      }}
    >
      <Icon name="Workflow" className="size-4" />
    </Button>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "graph",
    title: "Agent Graph",
    icon: "Workflow",
    path: "graph",
    component: OverviewPage,
    fixedTabs: [
      {
        ...THREAD_TAB,
        title: "Thread",
        icon: "MessageSquare",
        layout: "flush",
        component: BesideThreadTab,
      },
    ],
  });
  app.slots.threadPanelAction({
    id: PANEL_ACTION_ID,
    title: "Agent graph",
    icon: "Workflow",
    layout: "flush",
    component: ThreadGraphPanel,
    run: ({ openPanel }) => {
      openPanel({ title: "Agent graph" });
    },
  });
  app.slots.experimental_threadHeaderAction({
    id: "graph-button",
    title: "Agent graph",
    component: ThreadHeaderButton,
  });
});
