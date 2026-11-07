// The agent graph view: a pannable, zoomable tree of agents, subagents and
// tool calls, with animated edges into running work and a detail panel for
// the selected node. Pure props in, callbacks out — app.tsx owns data.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import type { Graph, GraphNode, NodeKind, NodeStatus } from "./contract";
import {
  childrenIndex,
  filterActive,
  isActive,
  layoutGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
  FOLD_SUFFIX,
  UNFOLD_SUFFIX,
  type LaidOutNode,
} from "./layout";
import { readStorage, writeStorage } from "./shared";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<NodeStatus, string> = {
  running: "Running",
  waiting: "Needs input",
  queued: "Queued",
  done: "Done",
  error: "Error",
  interrupted: "Interrupted",
  idle: "Idle",
};
const STATUS_ORDER: NodeStatus[] = [
  "running",
  "waiting",
  "queued",
  "error",
  "interrupted",
  "done",
  "idle",
];
const KIND_ICON: Record<NodeKind, IconName> = {
  root: "Target",
  project: "Folder",
  thread: "MessageSquare",
  turn: "Zap",
  tool: "ToolCase",
  subagent: "Bot",
  workflow: "Workflow",
  agent: "Bot",
  more: "MoreHorizontal",
};
const KIND_LABEL: Record<NodeKind, string> = {
  root: "Overview",
  project: "Project",
  thread: "Thread",
  turn: "Turn",
  tool: "Tool call",
  subagent: "Subagent",
  workflow: "Workflow",
  agent: "Workflow agent",
  more: "Hidden",
};

/** Visual node type: node kind, with tool calls split by what they do. */
type Category =
  | "project"
  | "thread"
  | "turn"
  | "shell"
  | "edit"
  | "read"
  | "web"
  | "tool"
  | "subagent"
  | "workflow"
  | "agent"
  | "other";
const CATEGORY_LABEL: Record<Category, string> = {
  project: "Project",
  thread: "Thread",
  turn: "Turn",
  shell: "Shell",
  edit: "File edit",
  read: "Read / search",
  web: "Web",
  tool: "Other tool",
  subagent: "Subagent",
  workflow: "Workflow",
  agent: "Workflow agent",
  other: "Other",
};
const CATEGORY_ORDER: Category[] = [
  "project",
  "thread",
  "turn",
  "subagent",
  "workflow",
  "agent",
  "shell",
  "edit",
  "read",
  "web",
  "tool",
];
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "LSP", "ToolSearch"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

function categoryOf(node: GraphNode): Category {
  switch (node.kind) {
    case "project":
    case "thread":
    case "turn":
    case "subagent":
    case "workflow":
    case "agent":
      return node.kind;
    case "tool": {
      const work = node.meta.kind ?? "";
      if (work === "command" || node.label === "Bash") return "shell";
      if (/file.?change/.test(work) || EDIT_TOOLS.has(node.label)) return "edit";
      if (/web/.test(work) || WEB_TOOLS.has(node.label)) return "web";
      if (/read|search|list/.test(work) || READ_TOOLS.has(node.label)) return "read";
      return "tool";
    }
    default:
      return "other";
  }
}

function categoryColor(category: Category): string {
  return `var(--ag-t-${category})`;
}

export type ColorMode = "type" | "status";
const COLOR_MODE_KEY = "agent-graph:color-mode";

function statusColor(status: NodeStatus): string {
  return `var(--ag-${status})`;
}

const CATEGORY_ICON: Partial<Record<Category, IconName>> = {
  shell: "Terminal",
  edit: "EditFile",
  read: "Search",
  web: "Globe",
};

/** Tool calls get an icon per category, so type never relies on color. */
function iconFor(node: GraphNode): IconName {
  if (node.kind === "tool") return CATEGORY_ICON[categoryOf(node)] ?? KIND_ICON.tool;
  return KIND_ICON[node.kind];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** How long a node ran, or has been running; null when unknown. */
function elapsedMs(node: GraphNode, now: number): number | null {
  if (node.startedAt === null) return null;
  const end = node.completedAt ?? (isActive(node.status) ? now : null);
  return end === null ? null : Math.max(0, end - node.startedAt);
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const STYLES = `
.ag-root {
  --ag-running: #3b82f6;
  --ag-waiting: #f59e0b;
  --ag-queued: #8b5cf6;
  --ag-done: #10b981;
  --ag-error: #ef4444;
  --ag-interrupted: #f97316;
  --ag-idle: color-mix(in oklab, currentColor 35%, transparent);
  --ag-t-project: #6366f1;
  --ag-t-thread: #0ea5e9;
  --ag-t-turn: #a855f7;
  --ag-t-subagent: #ec4899;
  --ag-t-workflow: #14b8a6;
  --ag-t-agent: #db2777;
  --ag-t-shell: #84cc16;
  --ag-t-edit: #f59e0b;
  --ag-t-read: #06b6d4;
  --ag-t-web: #3b82f6;
  --ag-t-tool: #94a3b8;
  --ag-t-other: color-mix(in oklab, currentColor 35%, transparent);
}
@keyframes ag-dash { to { stroke-dashoffset: -24; } }
@keyframes ag-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--ag-c) 55%, transparent); }
  70% { box-shadow: 0 0 0 8px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@keyframes ag-in { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: none; } }
.ag-edge-live { stroke-dasharray: 6 6; animation: ag-dash .8s linear infinite; }
.ag-node { transition: transform .35s cubic-bezier(.2,.8,.2,1); }
.ag-card { animation: ag-in .3s ease-out; }
.ag-live .ag-card { animation: ag-in .3s ease-out, ag-pulse 1.8s ease-out infinite; }
.ag-dot-live { animation: ag-pulse 1.4s ease-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .ag-edge-live, .ag-live .ag-card, .ag-dot-live, .ag-card { animation: none; }
  .ag-node { transition: none; }
  .ag-root .animate-spin { animation: none; }
  .ag-root path { transition: none !important; }
}
`;

function StatusDot({ status, className }: { status: NodeStatus; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "running" && "ag-dot-live",
        className,
      )}
      style={{ background: statusColor(status), ["--ag-c" as string]: statusColor(status) }}
    />
  );
}

function NodeCard({
  item,
  selected,
  onSelect,
  onToggle,
  onOpen,
  colorMode,
}: {
  item: LaidOutNode;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onOpen: (() => void) | null;
  colorMode: ColorMode;
}) {
  const { node, childCount, collapsed, hidden } = item;
  const byType = colorMode === "type" && node.kind !== "root" && node.kind !== "more";
  const color = byType ? categoryColor(categoryOf(node)) : statusColor(node.status);
  const hiddenActive = (hidden.running ?? 0) + (hidden.waiting ?? 0);
  return (
    <div
      className={cn("ag-node absolute", node.status === "running" && "ag-live")}
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        transform: `translate(${item.x}px, ${item.y}px)`,
      }}
    >
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`${KIND_LABEL[node.kind]}: ${node.label}, ${STATUS_LABEL[node.status]}`}
        title={
          node.kind === "more"
            ? "Click to show"
            : `${node.label} — ${STATUS_LABEL[node.status]}\nClick for details${onOpen ? " · double-click to open chat" : ""}`
        }
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onSelect}
        onDoubleClick={onOpen ?? undefined}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect();
          }
        }}
        className={cn(
          "ag-card relative flex h-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg border bg-card pl-3 pr-2 text-left shadow-sm outline-none transition-colors",
          "hover:border-foreground/30 focus-visible:ring-1 focus-visible:ring-ring",
          selected
            ? "border-foreground/60 ring-1 ring-foreground/20"
            : node.status === "error"
              ? "border-[var(--ag-error)] border-2"
              : node.status === "waiting"
                ? "border-[var(--ag-waiting)] border-2 border-dashed"
                : "border-border",
          node.kind === "more" && "border-dashed bg-transparent shadow-none",
        )}
        style={{ ["--ag-c" as string]: statusColor(node.status) }}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-1"
          style={{ background: color }}
        />
        {byType ? (
          <StatusDot status={node.status} className="absolute right-1.5 top-1.5" />
        ) : null}
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-md"
          style={{
            background: `color-mix(in oklab, ${color} 16%, transparent)`,
            color,
          }}
        >
          {node.status === "running" && node.kind !== "root" ? (
            <Icon name="Spinner" className="size-4 animate-spin" />
          ) : (
            <Icon name={iconFor(node)} className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-5 text-foreground">
            {node.label}
          </span>
          <span className="block truncate text-[11px] leading-4 text-muted-foreground">
            {node.sublabel ?? KIND_LABEL[node.kind]}
          </span>
        </span>
        {childCount > 0 ? (
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            aria-label={collapsed ? `Expand ${childCount} ${childCount === 1 ? "child" : "children"}` : "Collapse"}
            aria-expanded={!collapsed}
            className="flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1 text-[11px] tabular-nums text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            {collapsed ? (
              <>
                {hiddenActive > 0 ? <StatusDot status="running" className="mr-0.5" /> : null}
                {childCount}
                <Icon name="ChevronRight" className="size-3.5" />
              </>
            ) : (
              <Icon name="ChevronLeft" className="size-3.5" />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Edges({ layout, width, height }: { layout: ReturnType<typeof layoutGraph>; width: number; height: number }) {
  return (
    <svg
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      width={width}
      height={height}
      aria-hidden
    >
      {layout.edges.map((edge) => {
        const x1 = edge.from.x + NODE_WIDTH;
        const y1 = edge.from.y + NODE_HEIGHT / 2;
        const x2 = edge.to.x;
        const y2 = edge.to.y + NODE_HEIGHT / 2;
        const mid = (x1 + x2) / 2;
        const live = isActive(edge.to.node.status);
        return (
          <path
            key={edge.id}
            d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
            fill="none"
            stroke={live ? statusColor(edge.to.node.status) : "currentColor"}
            strokeOpacity={live ? 0.9 : 0.18}
            strokeWidth={live ? 1.75 : 1.25}
            className={cn(live && "ag-edge-live")}
            style={{ transition: "d .35s cubic-bezier(.2,.8,.2,1)" }}
          />
        );
      })}
    </svg>
  );
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function DetailPanel({
  node,
  childCount,
  onClose,
  onOpenThread,
  onOpenBeside,
  overlay,
}: {
  node: GraphNode;
  childCount: number;
  onClose: () => void;
  onOpenThread: ((threadId: string) => void) | null;
  onOpenBeside: ((threadId: string) => void) | null;
  overlay: boolean;
}) {
  const now = useNow(isActive(node.status));
  const elapsed = elapsedMs(node, now);
  const duration = elapsed === null ? null : formatDuration(elapsed);
  const meta = Object.entries(node.meta).filter(([, value]) => value !== "");
  return (
    <aside
      aria-label="Node details"
      className={cn(
        "flex flex-col border-l border-border bg-background",
        overlay
          ? "absolute inset-y-0 right-0 z-20 w-[min(20rem,90%)] shadow-lg"
          : "h-full w-80 shrink-0",
      )}
    >
      <header className="flex items-start gap-2 border-b border-border p-3">
        <span
          className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md"
          style={{
            background: `color-mix(in oklab, ${categoryColor(categoryOf(node))} 16%, transparent)`,
            color: categoryColor(categoryOf(node)),
          }}
        >
          <Icon name={iconFor(node)} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-muted-foreground">
            {node.kind === "tool" ? `Tool call · ${CATEGORY_LABEL[categoryOf(node)]}` : KIND_LABEL[node.kind]}
          </p>
          <h2 className="break-words text-sm font-medium leading-5">{node.label}</h2>
        </div>
        <Button variant="ghost" size="icon" className="size-7" aria-label="Close details" onClick={onClose}>
          <Icon name="X" className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <StatusDot status={node.status} />
            {STATUS_LABEL[node.status]}
          </span>
          {duration ? <span className="text-muted-foreground">{duration}</span> : null}
          {node.startedAt ? (
            <span className="text-muted-foreground">
              started {new Date(node.startedAt).toLocaleTimeString()}
            </span>
          ) : null}
          {childCount > 0 ? (
            <span className="text-muted-foreground">{childCount} {childCount === 1 ? "child" : "children"}</span>
          ) : null}
        </div>
        {node.sublabel ? (
          <p className="break-words text-xs text-muted-foreground">{node.sublabel}</p>
        ) : null}
        {meta.length > 0 ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            {meta.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="truncate font-mono" title={value}>{value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {node.input ? (
          <DetailBlock title={node.kind === "turn" ? "Prompt" : "Input"}>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-4">
              {node.input}
            </pre>
          </DetailBlock>
        ) : null}
        {node.output ? (
          <DetailBlock title={node.kind === "turn" ? "Latest reply" : "Output"}>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-4">
              {node.output}
            </pre>
          </DetailBlock>
        ) : null}
      </div>
      {node.threadId && (onOpenThread || onOpenBeside) ? (
        <footer className="flex gap-2 border-t border-border p-3">
          {onOpenBeside ? (
            <Button size="sm" className="flex-1" onClick={() => onOpenBeside(node.threadId!)}>
              <Icon name="MessageSquare" className="size-4" />
              Chat beside graph
            </Button>
          ) : null}
          {onOpenThread ? (
            <Button variant="outline" size="sm" className="flex-1" onClick={() => onOpenThread(node.threadId!)}>
              Go to thread
            </Button>
          ) : null}
        </footer>
      ) : null}
    </aside>
  );
}

interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export function AgentGraphView({
  graph,
  error,
  onOpenThread,
  onOpenBeside = null,
  compact = false,
  toolbarExtra = null,
  onRetry = null,
}: {
  graph: Graph | null;
  error: string | null;
  /** Retry after a failed refresh. */
  onRetry?: (() => void) | null;
  onOpenThread: ((threadId: string) => void) | null;
  /** Open the thread's chat next to the graph (the page's right panel). */
  onOpenBeside?: ((threadId: string) => void) | null;
  compact?: boolean;
  /** Extra controls rendered first in the toolbar row. */
  toolbarExtra?: ReactNode;
}) {
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>(() =>
    readStorage(COLOR_MODE_KEY) === "status" ? "status" : "type",
  );
  const changeColorMode = (mode: ColorMode) => {
    setColorMode(mode);
    writeStorage(COLOR_MODE_KEY, mode);
  };
  const [view, setView] = useState<Viewport>({ x: 24, y: 24, scale: 1 });
  const containerRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  const dragRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const movedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Below this width a docked detail panel would crush the graph; float it.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 900);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const nodes = useMemo(() => {
    if (!graph) return [];
    return activeOnly ? filterActive(graph.nodes) : graph.nodes;
  }, [graph, activeOnly]);
  const layout = useMemo(() => layoutGraph(nodes, overrides), [nodes, overrides]);
  const selected = layout.nodes.find((item) => item.node.id === selectedId) ?? null;

  const counts = useMemo(() => {
    const result: Partial<Record<NodeStatus, number>> = {};
    for (const node of graph?.nodes ?? []) {
      if (node.kind === "root" || node.kind === "project" || node.kind === "more") continue;
      result[node.status] = (result[node.status] ?? 0) + 1;
    }
    return result;
  }, [graph]);
  const categories = useMemo(() => {
    const result: Partial<Record<Category, number>> = {};
    for (const node of graph?.nodes ?? []) {
      if (node.kind === "root" || node.kind === "more") continue;
      const category = categoryOf(node);
      result[category] = (result[category] ?? 0) + 1;
    }
    return result;
  }, [graph]);

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el || layout.nodes.length === 0) return;
    const pad = 32;
    const top = 64; // clear the toolbar
    const fitScale = Math.min(
      (el.clientWidth - pad * 2) / layout.width,
      (el.clientHeight - top - pad) / layout.height,
    );
    // Never shrink cards past legibility.
    const scale = Math.min(1, Math.max(compact ? 0.4 : 0.6, fitScale));
    // Too big along an axis: frame the newest running work (or the newest
    // node), right-aligned so its ancestors stay in view to the left.
    const focus =
      [...layout.nodes].reverse().find((item) => item.node.status === "running" && item.childCount === 0) ??
      layout.nodes[layout.nodes.length - 1]!;
    const fitsX = layout.width * scale <= el.clientWidth - pad * 2;
    const fitsY = layout.height * scale <= el.clientHeight - top - pad;
    setView({
      scale,
      x: fitsX
        ? (el.clientWidth - layout.width * scale) / 2
        : Math.min(pad, el.clientWidth - pad - (focus.x + NODE_WIDTH) * scale),
      y: fitsY
        ? top + (el.clientHeight - top - pad - layout.height * scale) / 2
        : Math.min(top, (el.clientHeight + top) / 2 - (focus.y + NODE_HEIGHT / 2) * scale),
    });
  }, [layout, compact]);

  // Fit once when the first graph arrives; later refreshes keep the user's view.
  useLayoutEffect(() => {
    if (!fittedRef.current && layout.nodes.length > 0) {
      fittedRef.current = true;
      fit();
    }
  }, [fit, layout.nodes.length]);

  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setView((current) => {
      const scale = Math.min(2.5, Math.max(0.2, current.scale * factor));
      const ratio = scale / current.scale;
      return { scale, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
    });
  }, []);

  // Wheel pans; pinch or ctrl/cmd+wheel zooms at the pointer. Needs a
  // non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = el.getBoundingClientRect();
        zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - rect.left, event.clientY - rect.top);
      } else {
        setView((current) => ({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    movedRef.current = false;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y) > 3) movedRef.current = true;
    setView((current) => ({
      ...current,
      x: drag.vx + event.clientX - drag.x,
      y: drag.vy + event.clientY - drag.y,
    }));
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const toggle = (item: LaidOutNode) => {
    setOverrides((current) => new Map(current).set(item.node.id, !item.collapsed));
  };
  // Walk the full tree, not just what is laid out: collapsed subtrees hide
  // their descendants from the layout.
  const expandAll = (expand: boolean) => {
    const index = childrenIndex(nodes);
    const next = new Map<string, boolean>();
    for (const node of nodes) {
      if ((index.get(node.id)?.length ?? 0) > 0) {
        next.set(node.id, !expand);
        if (expand) next.set(node.id + UNFOLD_SUFFIX, true);
      }
    }
    setOverrides(next);
  };

  const running = layout.nodes.filter((item) => item.node.status === "running" && item.childCount === 0);
  const hiddenRunning = layout.nodes.reduce((sum, item) => sum + (item.collapsed ? (item.hidden.running ?? 0) : 0), 0);
  // Cycle through running work, newest first.
  const jumpIndexRef = useRef(0);
  const jumpToRunning = () => {
    const el = containerRef.current;
    if (!el) return;
    if (running.length === 0) {
      // Running work is folded away: expand, and the next click can jump.
      if (hiddenRunning > 0) expandAll(true);
      return;
    }
    const target = [...running].reverse()[jumpIndexRef.current % running.length]!;
    jumpIndexRef.current += 1;
    setView((current) => {
      const scale = Math.max(current.scale, 0.8);
      return {
        scale,
        x: el.clientWidth / 2 - (target.x + NODE_WIDTH / 2) * scale,
        y: el.clientHeight / 2 - (target.y + NODE_HEIGHT / 2) * scale,
      };
    });
    setSelectedId(target.node.id);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const c = center();
    switch (event.key) {
      case "Escape":
        if (selectedId !== null) {
          setSelectedId(null);
          event.stopPropagation();
        }
        break;
      case "+":
      case "=":
        zoomAt(1.25, c.x, c.y);
        break;
      case "-":
        zoomAt(0.8, c.x, c.y);
        break;
      case "0":
        fit();
        break;
      case "j":
        jumpToRunning();
        break;
      default:
        return;
    }
  };

  const center = () => {
    const el = containerRef.current;
    return el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: 0, y: 0 };
  };

  return (
    <div ref={rootRef} className="ag-root relative flex h-full min-h-0 w-full flex-1 overflow-hidden text-foreground">
      <style>{STYLES}</style>
      <div className="relative min-w-0 flex-1">
        <div className="pointer-events-none absolute left-3 right-3 top-3 z-10 flex flex-wrap items-center gap-2 [&>*]:pointer-events-auto">
          {toolbarExtra}
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background/90 p-1 shadow-sm backdrop-blur">
            <Button variant="ghost" size="sm" className="h-7 px-2" aria-pressed={activeOnly} onClick={() => setActiveOnly((value) => !value)}>
              Active only
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              aria-label={`Color by ${colorMode === "type" ? "status" : "type"}`}
              onClick={() => changeColorMode(colorMode === "type" ? "status" : "type")}
            >
              Color: {colorMode === "type" ? "Type" : "Status"}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => expandAll(true)}>
              Expand
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => expandAll(false)}>
              Collapse
            </Button>
          </div>
        </div>
        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2">
          {running.length > 0 || hiddenRunning > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-1.5 bg-background/90 shadow-sm backdrop-blur"
              onClick={jumpToRunning}
              aria-label={`Jump to running work (${running.length || hiddenRunning}), shortcut J`}
            >
              <StatusDot status="running" />
              Running {running.length || hiddenRunning}
            </Button>
          ) : null}
          <div className="flex items-center gap-0.5 rounded-lg border border-border bg-background/90 p-1 shadow-sm backdrop-blur">
            <Button variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label="Zoom out, shortcut minus" onClick={() => { const c = center(); zoomAt(0.8, c.x, c.y); }}>
              −
            </Button>
            <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
              {Math.round(view.scale * 100)}%
            </span>
            <Button variant="ghost" size="sm" className="h-7 w-7 px-0" aria-label="Zoom in, shortcut plus" onClick={() => { const c = center(); zoomAt(1.25, c.x, c.y); }}>
              +
            </Button>
            <Button variant="ghost" size="sm" className="h-7 px-2" aria-label="Fit to view, shortcut 0" onClick={fit}>
              Fit
            </Button>
          </div>
        </div>
        <details
          key={compact || narrow ? "legend-closed" : "legend-open"}
          className="group absolute bottom-3 left-3 z-10 max-w-[calc(100%-20rem)] rounded-lg border border-border bg-background/90 text-xs shadow-sm backdrop-blur"
          open={!compact && !narrow}
        >
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 [&::-webkit-details-marker]:hidden">
            <span className="font-medium">Legend</span>
            {STATUS_ORDER.filter((status) => isActive(status) && (counts[status] ?? 0) > 0).map((status) => (
              <span key={status} className="inline-flex items-center gap-1 text-muted-foreground group-open:hidden">
                <StatusDot status={status} />
                <span className="tabular-nums">{counts[status]}</span>
              </span>
            ))}
            <Icon name="ChevronUp" className="size-3.5 text-muted-foreground group-open:rotate-180" />
          </summary>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border px-3 py-2" aria-label="Legend">
            {colorMode === "type"
              ? CATEGORY_ORDER.filter((category) => (categories[category] ?? 0) > 0).map((category) => (
                  <span key={category} className="inline-flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block size-2.5 rounded-sm"
                      style={{ background: categoryColor(category) }}
                    />
                    <span className="text-muted-foreground">{CATEGORY_LABEL[category]}</span>
                  </span>
                ))
              : null}
            {colorMode === "type" ? <span className="basis-full" /> : null}
            {STATUS_ORDER.filter((status) => (counts[status] ?? 0) > 0).map((status) => (
              <span key={status} className="inline-flex items-center gap-1.5">
                <StatusDot status={status} />
                <span className="text-muted-foreground">{STATUS_LABEL[status]}</span>
                <span className="tabular-nums">{counts[status]}</span>
              </span>
            ))}
            {graph?.truncated ? <span className="text-muted-foreground">· truncated</span> : null}
            <span className="basis-full text-muted-foreground">
              Click a node for details · double-click to open its chat · drag or scroll to pan · ⌘/ctrl+scroll to zoom · J jumps to running work
            </span>
          </div>
        </details>
        {error && graph !== null ? (
          <div role="alert" className="absolute left-1/2 top-16 z-20 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/40 bg-background px-3 py-2 text-xs shadow-md">
            <span className="text-destructive">Couldn’t refresh: {error}</span>
            {onRetry ? (
              <Button variant="outline" size="sm" className="h-7" onClick={onRetry}>
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}
        <div
          ref={containerRef}
          className="absolute inset-0 cursor-grab touch-none select-none overflow-hidden active:cursor-grabbing"
          style={{
            backgroundImage:
              "radial-gradient(color-mix(in oklab, currentColor 12%, transparent) 1px, transparent 1px)",
            backgroundSize: `${20 * view.scale}px ${20 * view.scale}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          tabIndex={0}
          role="application"
          aria-label="Agent graph. Plus and minus zoom, 0 fits, J jumps to running work, Escape closes details."
          onKeyDown={onKeyDown}
          onClick={(event) => {
            if (event.target === event.currentTarget && !movedRef.current) setSelectedId(null);
          }}
        >
          <div
            className="absolute left-0 top-0 origin-top-left"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          >
            <Edges layout={layout} width={layout.width} height={layout.height} />
            {layout.nodes.map((item) => (
              <NodeCard
                key={item.node.id}
                item={item}
                colorMode={colorMode}
                selected={item.node.id === selectedId}
                onSelect={() => {
                  if (item.node.id.endsWith(FOLD_SUFFIX) && item.node.parentId) {
                    const unfold = item.node.parentId + UNFOLD_SUFFIX;
                    setOverrides((current) => new Map(current).set(unfold, true));
                  } else {
                    setSelectedId(item.node.id);
                  }
                }}
                onToggle={() => toggle(item)}
                onOpen={
                  item.node.threadId && (onOpenBeside ?? onOpenThread)
                    ? () => (onOpenBeside ?? onOpenThread)!(item.node.threadId!)
                    : null
                }
              />
            ))}
          </div>
          {graph === null || layout.nodes.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
              <div
                role={error ? "alert" : "status"}
                className={cn(
                  "pointer-events-auto flex flex-col items-center gap-3 rounded-lg border border-dashed border-border bg-background px-4 py-6 text-center text-sm",
                  error ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {error ??
                  (graph === null
                    ? "Loading agent graph…"
                    : activeOnly
                      ? "Nothing is running right now."
                      : "No agent activity in this window.")}
                {error && onRetry ? (
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    Retry
                  </Button>
                ) : null}
                {!error && graph !== null && activeOnly ? (
                  <Button variant="outline" size="sm" onClick={() => setActiveOnly(false)}>
                    Show everything
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {selected ? (
        <DetailPanel
          node={selected.node}
          childCount={selected.childCount}
          onClose={() => setSelectedId(null)}
          onOpenThread={onOpenThread}
          onOpenBeside={onOpenBeside}
          overlay={compact || narrow}
        />
      ) : null}
    </div>
  );
}
