// bb-plugin-agent-graph — backend.
//
// Builds a live node graph of what agents are doing: project → thread →
// turn → tool call / subagent / workflow agent, plus child threads nested
// under their parent. The frontend lays it out and animates it; the
// `bb agent-graph` CLI prints the same graph as a tree.
//
// Timelines are read loosely (as records) so new row kinds degrade to a
// generic "tool" node instead of breaking the graph.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { normalizeTurns, type Row } from "./timeline";
import {
  GRAPH_CHANGED,
  MAX_OVERRIDES,
  MAX_PRESETS,
  MAX_SAVED_VIEWS,
  type GraphChangedPayload,
  type Preset,
  type ViewState,
} from "./shared";
import {
  buildFacets,
  FACET_KEYS,
  isHidden,
  normalizeFilter,
  threadKind,
  type ThreadFacts,
  type ThreadFilter,
} from "./filters";

const nodeKindSchema = z.enum([
  "root",
  "project",
  "thread",
  "turn",
  "tool",
  "subagent",
  "workflow",
  "agent",
  "more",
]);
const nodeStatusSchema = z.enum([
  "running",
  "waiting",
  "queued",
  "done",
  "error",
  "interrupted",
  "idle",
]);
const graphNodeSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  kind: nodeKindSchema,
  label: z.string(),
  sublabel: z.string().nullable(),
  status: nodeStatusSchema,
  threadId: z.string().nullable(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  input: z.string().nullable(),
  output: z.string().nullable(),
  meta: z.record(z.string(), z.string()),
});
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type NodeKind = z.infer<typeof nodeKindSchema>;
export type NodeStatus = z.infer<typeof nodeStatusSchema>;

const facetValueSchema = z.object({
  value: z.string(),
  label: z.string(),
  count: z.number(),
  color: z.string().nullable().optional(),
});
const facetsSchema = z.object(
  Object.fromEntries(FACET_KEYS.map((key) => [key, z.array(facetValueSchema)])) as Record<
    (typeof FACET_KEYS)[number],
    z.ZodArray<typeof facetValueSchema>
  >,
);
const filterSchema = z.object(
  Object.fromEntries(
    FACET_KEYS.map((key) => [key, z.array(z.string().max(200)).max(500).optional()]),
  ) as Record<(typeof FACET_KEYS)[number], z.ZodOptional<z.ZodArray<z.ZodString>>>,
);

const graphSchema = z.object({
  nodes: z.array(graphNodeSchema),
  generatedAt: z.number(),
  truncated: z.boolean(),
  /** What the overview can be filtered on; null for a single-thread graph. */
  facets: facetsSchema.nullable(),
  /** Threads the filter hid from the overview. */
  filteredOut: z.number(),
});
export type Graph = z.infer<typeof graphSchema>;

const viewStateSchema = z.object({
  baseline: z.enum(["default", "expanded", "collapsed"]),
  overrides: z.record(z.string(), z.boolean()),
  activeOnly: z.boolean(),
  colorMode: z.enum(["type", "status"]),
  filter: filterSchema.optional(),
  viewport: z
    .object({ x: z.number(), y: z.number(), scale: z.number().min(0.05).max(10) })
    .nullable(),
});
const presetSchema = z.object({
  name: z.string(),
  state: viewStateSchema,
  savedAt: z.number(),
});
const viewKeySchema = z.string().min(1).max(200);
const presetNameSchema = z.string().trim().min(1).max(60);

export const rpcContract = defineRpcContract({
  graph: {
    input: z.object({
      threadId: z.string().nullable(),
      /** Overview only: values to hide. */
      filter: filterSchema.optional(),
    }),
    output: graphSchema,
  },
  /** Called by Labels Pro after label changes (plugin to plugin). */
  labelsChanged: {
    input: z.unknown(),
    output: z.object({ ok: z.boolean() }),
  },
  /** The saved state of one view; `fallbackKey` is read when `key` has none. */
  viewGet: {
    input: z.object({ key: viewKeySchema, fallbackKey: viewKeySchema.nullable() }),
    output: z.object({ state: viewStateSchema.nullable(), fromFallback: z.boolean() }),
  },
  /** Save one view; `alsoKey` gets the same state (the fallback for new views). */
  viewSet: {
    input: z.object({
      key: viewKeySchema,
      alsoKey: viewKeySchema.nullable(),
      state: viewStateSchema,
    }),
    output: z.object({ ok: z.boolean() }),
  },
  presetsList: {
    input: z.object({}),
    output: z.array(presetSchema),
  },
  /** Save a preset; a preset with the same name is replaced. */
  presetSave: {
    input: z.object({ name: presetNameSchema, state: viewStateSchema }),
    output: z.array(presetSchema),
  },
  presetDelete: {
    input: z.object({ name: z.string() }),
    output: z.array(presetSchema),
  },
});

/** Keep the newest per-node choices only, so a long-lived view stays small. */
function trimState(state: ViewState): ViewState {
  const entries = Object.entries(state.overrides);
  if (entries.length <= MAX_OVERRIDES) return state;
  return { ...state, overrides: Object.fromEntries(entries.slice(-MAX_OVERRIDES)) };
}


type ThreadDto = {
  id: string;
  projectId: string;
  title: string | null;
  titleFallback: string | null;
  status: string;
  parentThreadId: string | null;
  originPluginId?: string | null;
  providerId: string | null;
  updatedAt: number;
  createdAt: number;
  hasPendingInteraction?: boolean;
  queuedWork?: string;
  environmentBranchName?: string | null;
  runtime?: { displayStatus?: string } | null;
};

const TEXT_CAP = 1500;
const LABEL_CAP = 80;
const MAX_WORK_PER_TURN = 40;
const OVERVIEW_WORK_LIMIT = 6;
/** Thread labels come from this plugin, when installed. */
const LABELS_PLUGIN_ID = "labels-pro";
const MAX_NODES = 1500;
const RUNNING_THREAD_STATUSES = new Set(["active", "starting", "pending"]);
const DELTA_EVENTS = new Set([
  "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/plan/delta",
  "thread/tokenUsage/updated",
  "thread/contextWindowUsage/updated",
  "provider/rateLimits/updated",
  "item/toolCall/progress",
  "item/mcpToolCall/progress",
  "item/backgroundTask/progress",
  "turn/diff/updated",
]);

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function clip(value: string | null, cap: number): string | null {
  if (value === null) return null;
  const flat = value.trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}
function oneLine(value: string | null, cap = LABEL_CAP): string | null {
  return clip(value === null ? null : value.replace(/\s+/g, " "), cap);
}
function json(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

function rowStatus(row: Row, threadRunning: boolean): NodeStatus {
  if (row.approvalStatus === "waiting_for_approval") return "waiting";
  switch (row.status) {
    case "completed":
      return "done";
    case "error":
      return "error";
    case "interrupted":
      return "interrupted";
    case "pending":
      return threadRunning ? "running" : "interrupted";
    default:
      return "done";
  }
}

function threadStatus(thread: ThreadDto): NodeStatus {
  if (thread.hasPendingInteraction) return "waiting";
  if (thread.status === "error") return "error";
  if (RUNNING_THREAD_STATUSES.has(thread.status)) return "running";
  if (thread.queuedWork !== undefined && thread.queuedWork !== "none")
    return "queued";
  return "idle";
}

/** The most useful one-line summary of a tool call's arguments. */
function summarizeArgs(args: unknown): string | null {
  if (args === null || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  for (const key of [
    "description",
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "prompt",
    "skill",
  ]) {
    const value = str(record[key]);
    if (value !== null) return oneLine(value);
  }
  return null;
}

function workLabel(row: Row): { label: string; sublabel: string | null } {
  const presentation = (row.presentation ?? null) as Row | null;
  const title = str(presentation?.title);
  const detail = str(presentation?.detail);
  switch (row.workKind) {
    case "command":
      return { label: "Bash", sublabel: oneLine(str(row.command)) };
    case "tool":
      return {
        label: str(row.toolName) ?? "Tool",
        sublabel: oneLine(detail ?? title) ?? summarizeArgs(row.toolArgs),
      };
    default: {
      const kind = str(row.workKind) ?? "work";
      const pretty = kind
        .split(/[-_]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      const hint =
        str(row.path) ??
        str(row.query) ??
        str(row.url) ??
        str(row.description) ??
        str(row.toolName);
      return {
        label: title ?? pretty,
        sublabel: oneLine(detail ?? hint),
      };
    }
  }
}

class GraphBuilder {
  nodes: GraphNode[] = [];
  truncated = false;

  /** Newest work rows kept per turn or subagent; older ones fold into "+N". */
  constructor(private readonly workLimit = MAX_WORK_PER_TURN) {}

  add(node: Omit<GraphNode, "meta"> & { meta?: Record<string, string> }) {
    if (this.nodes.length >= MAX_NODES) {
      this.truncated = true;
      return false;
    }
    this.nodes.push({ meta: {}, ...node });
    return true;
  }

  /** Map work rows (tool calls, subagents, workflows) under `parentId`. */
  addWork(
    rows: Row[],
    parentId: string,
    threadId: string,
    threadRunning: boolean,
  ) {
    const work = rows.filter((row) => row.kind === "work");
    // Subagents and workflows always stay visible; plain tool calls keep
    // only the newest `workLimit`.
    const keepFrom = Math.max(0, work.length - this.workLimit);
    const shown = work.filter(
      (row, index) =>
        index >= keepFrom ||
        row.workKind === "delegation" ||
        row.workKind === "workflow",
    );
    const hidden = work.length - shown.length;
    shown.forEach((row, index) => {
      // Stable ids keep React keys, selection and collapse state across
      // refetches; fall back to position when a row has no id.
      const id = `${threadId}:${str(row.id) ?? `${parentId}:w${index}`}`;
      const status = rowStatus(row, threadRunning);
      const base = {
        id,
        parentId,
        threadId,
        status,
        startedAt: num(row.startedAt),
        completedAt: num(row.completedAt),
      };
      if (row.workKind === "delegation") {
        const childRows = Array.isArray(row.childRows)
          ? (row.childRows as Row[])
          : [];
        // A background subagent's delegation completes at launch; its
        // child rows tell whether it is still working.
        const childWork = childRows.filter((child) => child.kind === "work");
        const lastChild = childWork.at(-1);
        // Between tool calls a background subagent has no pending child;
        // it is still working until it hands back (Claude Code's
        // SubagentHandback) or the parent thread stops.
        const handback = childWork.find(
          (child) => child.toolName === "SubagentHandback",
        );
        const handedBack = handback !== undefined;
        const handbackArgs = (handback?.toolArgs ?? null) as Row | null;
        // A background delegation's own output is just the launch receipt;
        // the subagent's real answer is its handback message.
        const report =
          str(handbackArgs?.message) ??
          (row.background === true ? null : str(row.output));
        const childRunning =
          childWork.some(
            (child) => rowStatus(child, threadRunning) === "running",
          ) ||
          (row.background === true && threadRunning && !handedBack);
        const childRef = str(row.childRef);
        const ok = this.add({
          ...base,
          status: childRunning ? "running" : status,
          completedAt:
            row.background === true && lastChild
              ? num(lastChild.completedAt)
              : base.completedAt,
          kind: "subagent",
          label:
            oneLine(str(row.description), 60) ??
            str(row.subagentType) ??
            "Subagent",
          sublabel: [str(row.subagentType) ?? "Subagent", `${childWork.length} steps`]
            .join(" · "),
          input: clip(str(row.description), TEXT_CAP),
          output: clip(report, TEXT_CAP),
          meta: {
            ...(str(row.subagentType) ? { type: str(row.subagentType)! } : {}),
            ...(row.background === true ? { mode: "background" } : {}),
            ...(childRef?.startsWith("thr_") ? { thread: childRef } : {}),
            ...(lastChild ? { "last step": workLabel(lastChild).label } : {}),
          },
        });
        if (ok) this.addWork(childRows, id, threadId, threadRunning);
        return;
      }
      if (row.workKind === "workflow") {
        const workflow = (row.workflow ?? null) as {
          agents?: Row[];
        } | null;
        const usage = (row.usage ?? null) as Row | null;
        const ok = this.add({
          ...base,
          status:
            row.taskStatus === "running"
              ? "running"
              : row.taskStatus === "failed" || row.taskStatus === "killed"
                ? "error"
                : status,
          kind: "workflow",
          label: str(row.workflowName) ?? "Workflow",
          sublabel: oneLine(str(row.description)),
          input: clip(str(row.description), TEXT_CAP),
          output: clip(str(row.summary) ?? str(row.error), TEXT_CAP),
          meta: {
            task: str(row.taskStatus) ?? "",
            ...(usage && num(usage.totalTokens) !== null
              ? { tokens: String(usage.totalTokens) }
              : {}),
          },
        });
        if (!ok) return;
        for (const agent of workflow?.agents ?? []) {
          const state = str(agent.state);
          this.add({
            id: `${id}:agent:${String(agent.index)}:${String(agent.attempt)}`,
            parentId: id,
            kind: "agent",
            label: str(agent.label) ?? `Agent ${String(agent.index)}`,
            sublabel: oneLine(
              str(agent.lastToolSummary) ??
                str(agent.lastToolName) ??
                str(agent.phaseTitle),
            ),
            status:
              state === "running"
                ? "running"
                : state === "queued"
                  ? "queued"
                  : state === "failed"
                    ? "error"
                    : state === "skipped"
                      ? "interrupted"
                      : "done",
            threadId,
            startedAt: num(agent.startedAt),
            completedAt: null,
            input: clip(str(agent.promptPreview), TEXT_CAP),
            output: clip(str(agent.resultPreview) ?? str(agent.error), TEXT_CAP),
            meta: {
              model: str(agent.model) ?? "",
              ...(str(agent.phaseTitle) ? { phase: str(agent.phaseTitle)! } : {}),
              ...(num(agent.tokens) !== null
                ? { tokens: String(agent.tokens) }
                : {}),
              ...(num(agent.toolCalls) !== null
                ? { "tool calls": String(agent.toolCalls) }
                : {}),
            },
          });
        }
        return;
      }
      const { label, sublabel } = workLabel(row);
      this.add({
        ...base,
        kind: "tool",
        label,
        sublabel,
        input: clip(
          row.workKind === "command"
            ? str(row.command)
            : json(row.toolArgs) ?? sublabel,
          TEXT_CAP,
        ),
        output: clip(str(row.output), TEXT_CAP),
        meta: {
          kind: str(row.workKind) ?? "work",
          ...(num(row.exitCode) !== null ? { exit: String(row.exitCode) } : {}),
        },
      });
    });
  }

  /** Map a thread's turns (newest `turnLimit`) under `parentId`. */
  addTurns(
    rows: Row[],
    parentId: string,
    threadId: string,
    threadRunning: boolean,
    turnLimit: number,
  ) {
    // Drop turns with nothing to show (no prompt, steps or reply), such as
    // bookkeeping turns, unless they are still live.
    const turns = normalizeTurns(rows, threadRunning).filter(
      (turn) =>
        turn.status === "pending" ||
        turn.children.some((row) => row.kind === "work" || row.kind === "conversation"),
    );
    const shown = turnLimit <= 0 ? [] : turns.slice(-turnLimit);
    if (turns.length > shown.length)
      this.add({
        id: `${threadId}:turns:more`,
        parentId,
        kind: "more",
        label: `+${turns.length - shown.length} earlier turns`,
        sublabel: null,
        status: "done",
        threadId,
        startedAt: null,
        completedAt: null,
        input: null,
        output: null,
      });
    shown.forEach((turn, index) => {
      const children = turn.children;
      const conversation = children.filter(
        (row) => row.kind === "conversation",
      );
      const prompt = conversation.find((row) => row.role === "user");
      const reply = [...conversation]
        .reverse()
        .find((row) => row.role === "assistant");
      const id = `${threadId}:turn:${turn.turnId}`;
      const work = children.filter((row) => row.kind === "work");
      const last = work.at(-1);
      const ok = this.add({
        id,
        parentId,
        kind: "turn",
        label:
          oneLine(str(prompt?.text), 60) ??
          // No user prompt: the agent was woken by a notification or event.
          (reply ? "Automatic turn" : `Turn ${turns.length - shown.length + index + 1}`),
        sublabel: `${work.length} step${work.length === 1 ? "" : "s"}`,
        status: rowStatus({ status: turn.status }, threadRunning),
        threadId,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        input: clip(str(prompt?.text), TEXT_CAP),
        output: clip(str(reply?.text), TEXT_CAP),
        meta: last ? { "last step": workLabel(last).label } : {},
      });
      if (ok) this.addWork(children, id, threadId, threadRunning);
    });
  }
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    windowHours: {
      type: "select",
      label: "Overview window (hours)",
      description:
        "The overview graph shows threads active within this many hours, plus anything running.",
      options: ["1", "6", "12", "24", "72"],
      default: "12",
    },
    maxThreads: {
      type: "select",
      label: "Max threads in overview",
      options: ["10", "20", "40"],
      default: "20",
    },
    overviewTurns: {
      type: "select",
      label: "Turns per thread in overview",
      options: ["0", "1", "2", "3"],
      default: "1",
    },
    threadTurns: {
      type: "select",
      label: "Turns in single-thread view",
      options: ["3", "8", "20"],
      default: "8",
    },
  });
  const parseConfig = (raw: Record<string, unknown>) => {
    const pick = (value: unknown, fallback: number, min: number, max: number) => {
      const parsed = Number(value);
      return Number.isFinite(parsed)
        ? Math.min(max, Math.max(min, Math.round(parsed)))
        : fallback;
    };
    return {
      windowHours: pick(raw.windowHours, 12, 1, 24 * 30),
      maxThreads: pick(raw.maxThreads, 20, 1, 100),
      overviewTurns: pick(raw.overviewTurns, 1, 0, 10),
      threadTurns: pick(raw.threadTurns, 8, 1, 50),
    };
  };
  let config = parseConfig(await settings.get());
  settings.onChange((next) => {
    config = parseConfig(next);
    buildCache.clear();
    bb.realtime.publish(GRAPH_CHANGED, { threadIds: [] } satisfies GraphChangedPayload);
  });

  // A thread's updatedAt does not move while a turn streams, so it is only
  // a hint: entries are also evicted on every structural thread:changed
  // event, running threads always refetch, and an entry only serves
  // requests for at most as many segments as it holds.
  const timelineCache = new Map<
    string,
    { updatedAt: number; segments: number; rows: Row[] }
  >();
  async function timelineRows(thread: ThreadDto, turns: number): Promise<Row[]> {
    const segments = Math.max(1, turns + 1);
    const cached = timelineCache.get(thread.id);
    if (
      cached &&
      cached.updatedAt === thread.updatedAt &&
      cached.segments >= segments &&
      threadStatus(thread) !== "running"
    ) {
      return cached.rows;
    }
    try {
      const timeline = await bb.sdk.threads.timeline({
        threadId: thread.id,
        includeNestedRows: "true",
        segmentLimit: String(segments),
      });
      const rows = timeline.rows as unknown as Row[];
      timelineCache.delete(thread.id);
      timelineCache.set(thread.id, { updatedAt: thread.updatedAt, segments, rows });
      if (timelineCache.size > 200) {
        const oldest = timelineCache.keys().next().value;
        if (oldest !== undefined) timelineCache.delete(oldest);
      }
      return rows;
    } catch (error) {
      bb.log.warn(`timeline failed for ${thread.id}: ${String(error)}`);
      return [];
    }
  }

  async function mapLimited<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
          const index = next++;
          results[index] = await fn(items[index]!);
        }
      }),
    );
    return results;
  }

  function threadNode(
    thread: ThreadDto,
    parentId: string | null,
    labels: string[] = [],
  ): Omit<GraphNode, "meta"> & { meta: Record<string, string> } {
    return {
      id: thread.id,
      parentId,
      kind: "thread",
      label:
        oneLine(thread.title ?? thread.titleFallback, 60) ?? "Untitled thread",
      sublabel: [thread.providerId, thread.environmentBranchName]
        .filter(Boolean)
        .join(" · ") || null,
      status: threadStatus(thread),
      threadId: thread.id,
      startedAt: thread.createdAt,
      completedAt: null,
      input: null,
      output: null,
      meta: {
        status: thread.runtime?.displayStatus ?? thread.status,
        ...(thread.providerId ? { provider: thread.providerId } : {}),
        ...(thread.environmentBranchName
          ? { branch: thread.environmentBranchName }
          : {}),
        ...(labels.length > 0 ? { labels: labels.join(", ") } : {}),
      },
    };
  }

  /** Threads plus their descendants, parents first. */
  async function addThreadTree(
    builder: GraphBuilder,
    threads: ThreadDto[],
    byParent: Map<string, ThreadDto[]>,
    parentIdFor: (thread: ThreadDto) => string | null,
    turns: number,
    labelNames: (thread: ThreadDto) => string[] = () => [],
  ) {
    const ordered: ThreadDto[] = [];
    const visit = (thread: ThreadDto, depth: number) => {
      ordered.push(thread);
      if (depth > 4) return;
      for (const child of byParent.get(thread.id) ?? []) visit(child, depth + 1);
    };
    threads.forEach((thread) => visit(thread, 0));
    const rows = await mapLimited(ordered, 4, (thread) =>
      timelineRows(thread, turns),
    );
    const orderedIds = new Set(ordered.map((thread) => thread.id));
    ordered.forEach((thread, index) => {
      const parentId =
        thread.parentThreadId && orderedIds.has(thread.parentThreadId)
          ? thread.parentThreadId
          : parentIdFor(thread);
      if (!builder.add(threadNode(thread, parentId, labelNames(thread)))) return;
      builder.addTurns(
        rows[index]!,
        thread.id,
        thread.id,
        RUNNING_THREAD_STATUSES.has(thread.status),
        turns,
      );
    });
  }

  async function allThreads(): Promise<ThreadDto[]> {
    const result = (await bb.sdk.threads.list({
      archived: false,
      limit: 300,
    })) as unknown as ThreadDto[];
    return Array.isArray(result) ? result : [];
  }

  // Thread labels come from the Labels Pro plugin when it is installed. Its
  // revision tells us cheaply whether anything changed since the last read.
  type LabelIndex = {
    revision: number;
    labels: Map<string, { name: string; slug: string; color: string | null }>;
    byThread: Map<string, string[]>;
  };
  let labelIndex: LabelIndex | null = null;
  const labelsOut = z.object({
    revision: z.number(),
    changed: z.boolean(),
    labels: z
      .array(
        z.object({ id: z.string(), name: z.string(), slug: z.string(), color: z.string().nullable() }).passthrough(),
      )
      .nullable(),
    assignments: z
      .array(z.object({ labelId: z.string(), threadIds: z.array(z.string()) }))
      .nullable(),
  });
  async function threadLabels(): Promise<LabelIndex | null> {
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: LABELS_PLUGIN_ID,
        method: "listAssignments",
        input: labelIndex ? { sinceRevision: labelIndex.revision } : {},
        outputSchema: labelsOut,
      });
      if (!result.changed && labelIndex) return labelIndex;
      const byThread = new Map<string, string[]>();
      for (const { labelId, threadIds } of result.assignments ?? []) {
        for (const threadId of threadIds) {
          const list = byThread.get(threadId) ?? [];
          list.push(labelId);
          byThread.set(threadId, list);
        }
      }
      labelIndex = {
        revision: result.revision,
        labels: new Map(
          (result.labels ?? []).map((label) => [
            label.id,
            { name: label.name, slug: label.slug, color: label.color },
          ]),
        ),
        byThread,
      };
      return labelIndex;
    } catch {
      // Labels Pro is not installed or not running: no label filter.
      labelIndex = null;
      return null;
    }
  }

  async function buildOverview(rawFilter: ThreadFilter): Promise<Graph> {
    const filter = normalizeFilter(rawFilter);
    const builder = new GraphBuilder(OVERVIEW_WORK_LIMIT);
    const [threads, projects, labels] = await Promise.all([
      allThreads(),
      bb.sdk.projects.list({ includePersonal: true }) as unknown as Promise<
        Array<{ id: string; name?: string | null }>
      >,
      threadLabels(),
    ]);
    const projectNames = new Map(
      (Array.isArray(projects) ? projects : []).map((project) => [
        project.id,
        project.name ?? project.id,
      ]),
    );
    const cutoff = Date.now() - config.windowHours * 3_600_000;
    const windowed = threads.filter(
      (thread) => threadStatus(thread) !== "idle" || thread.updatedAt >= cutoff,
    );
    const factsOf = (thread: ThreadDto): ThreadFacts => {
      const labelIds = labels?.byThread.get(thread.id) ?? [];
      return {
        project: thread.projectId,
        labels: labelIds,
        kind: threadKind({
          originPluginId: thread.originPluginId,
          parentThreadId: thread.parentThreadId,
          title: thread.title,
          labelSlugs: labelIds.map((id) => labels?.labels.get(id)?.slug ?? ""),
        }),
        status: threadStatus(thread),
        provider: thread.providerId ?? "",
      };
    };
    const facts = new Map(windowed.map((thread) => [thread.id, factsOf(thread)]));
    const facets = buildFacets([...facts.values()], filter, {
      project: (id) => projectNames.get(id) ?? id,
      label: (id) => labels?.labels.get(id) ?? null,
    });
    if (!labels) facets.label = [];
    // Filter before the thread cap, so hidden threads make room for others.
    const shown = windowed.filter((thread) => !isHidden(facts.get(thread.id)!, filter));
    const labelNames = (thread: ThreadDto) =>
      (facts.get(thread.id)?.labels ?? [])
        .map((id) => labels?.labels.get(id)?.name)
        .filter((name): name is string => Boolean(name));
    const recent = shown
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, config.maxThreads));
    const included = new Set(recent.map((thread) => thread.id));
    const byParent = new Map<string, ThreadDto[]>();
    for (const thread of recent) {
      if (thread.parentThreadId && included.has(thread.parentThreadId)) {
        const siblings = byParent.get(thread.parentThreadId) ?? [];
        siblings.push(thread);
        byParent.set(thread.parentThreadId, siblings);
      }
    }
    const roots = recent.filter(
      (thread) => !thread.parentThreadId || !included.has(thread.parentThreadId),
    );
    builder.add({
      id: "root",
      parentId: null,
      kind: "root",
      label: "Agents",
      sublabel: `${recent.length} thread${recent.length === 1 ? "" : "s"}`,
      status: recent.some((thread) => threadStatus(thread) === "running")
        ? "running"
        : "idle",
      threadId: null,
      startedAt: null,
      completedAt: null,
      input: null,
      output: null,
    });
    for (const projectId of new Set(roots.map((thread) => thread.projectId))) {
      const projectThreads = recent.filter(
        (thread) => thread.projectId === projectId,
      );
      const statuses = projectThreads.map(threadStatus);
      builder.add({
        id: `project:${projectId}`,
        parentId: "root",
        kind: "project",
        label: projectNames.get(projectId) ?? projectId,
        sublabel: `${projectThreads.length} thread${projectThreads.length === 1 ? "" : "s"}`,
        status: statuses.includes("running")
          ? "running"
          : statuses.includes("waiting")
            ? "waiting"
            : "idle",
        threadId: null,
        startedAt: null,
        completedAt: null,
        input: null,
        output: null,
      });
    }
    await addThreadTree(
      builder,
      roots,
      byParent,
      (thread) => `project:${thread.projectId}`,
      Math.max(0, config.overviewTurns),
      labelNames,
    );
    return {
      nodes: builder.nodes,
      generatedAt: Date.now(),
      truncated: builder.truncated,
      facets,
      filteredOut: windowed.length - shown.length,
    };
  }

  async function buildThread(threadId: string): Promise<Graph> {
    const builder = new GraphBuilder();
    const root = (await bb.sdk.threads.get({ threadId })) as unknown as ThreadDto;
    const byParent = new Map<string, ThreadDto[]>();
    // Walk descendants breadth-first, a few levels deep.
    let frontier = [root.id];
    for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
      const levels = await mapLimited(frontier, 4, async (parentThreadId) => {
        const children = (await bb.sdk.threads.list({
          parentThreadId,
          includeHidden: true,
          limit: 100,
        })) as unknown as ThreadDto[];
        return { parentThreadId, children: Array.isArray(children) ? children : [] };
      });
      const next: string[] = [];
      for (const { parentThreadId, children } of levels) {
        if (children.length === 0) continue;
        byParent.set(parentThreadId, children);
        next.push(...children.map((child) => child.id));
      }
      frontier = next;
    }
    await addThreadTree(
      builder,
      [{ ...root, parentThreadId: null }],
      byParent,
      () => null, // the focused thread is the root
      Math.max(1, config.threadTurns),
    );
    return {
      nodes: builder.nodes,
      generatedAt: Date.now(),
      truncated: builder.truncated,
      facets: null,
      filteredOut: 0,
    };
  }

  // Every open window asks for the graph on the same realtime signal, so
  // share one in-flight build per scope and reuse it for a moment after.
  const BUILD_MEMO_MS = 750;
  const buildCache = new Map<string, { at: number; promise: Promise<Graph> }>();
  function graphFor(threadId: string | null, filter: ThreadFilter = {}): Promise<Graph> {
    const key = threadId ?? `*${JSON.stringify(normalizeFilter(filter))}`;
    const cached = buildCache.get(key);
    if (cached && Date.now() - cached.at < BUILD_MEMO_MS) return cached.promise;
    const promise = threadId === null ? buildOverview(filter) : buildThread(threadId);
    buildCache.set(key, { at: Date.now(), promise });
    promise.catch(() => buildCache.delete(key));
    if (buildCache.size > 50) {
      const oldest = buildCache.keys().next().value;
      if (oldest !== undefined) buildCache.delete(oldest);
    }
    return promise;
  }

  // Saved views and presets live in the plugin's key-value store, so they
  // follow the user between the desktop app and a browser. Writes run one at
  // a time so the index of saved views never loses an update.
  const VIEW_PREFIX = "view:";
  const VIEW_INDEX_KEY = "views:index";
  const PRESETS_KEY = "presets";
  const kv = bb.storage.kv;
  let writes: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = writes.then(task, task);
    writes = run.catch(() => undefined);
    return run;
  };
  const readView = async (key: string): Promise<ViewState | null> => {
    const parsed = viewStateSchema.safeParse(await kv.get(VIEW_PREFIX + key));
    return parsed.success ? parsed.data : null;
  };
  const readPresets = async (): Promise<Preset[]> => {
    const parsed = z.array(presetSchema).safeParse(await kv.get(PRESETS_KEY));
    return parsed.success ? parsed.data : [];
  };
  const writeViews = (keys: string[], state: ViewState) =>
    serialized(async () => {
      const trimmed = trimState(state);
      const index =
        (await kv.get<Array<{ key: string; at: number }>>(VIEW_INDEX_KEY)) ?? [];
      const now = Date.now();
      const next = [
        ...index.filter((entry) => !keys.includes(entry.key)),
        ...keys.map((key) => ({ key, at: now })),
      ];
      // Drop the least recently saved views past the cap.
      const dropped = next.length > MAX_SAVED_VIEWS ? next.splice(0, next.length - MAX_SAVED_VIEWS) : [];
      for (const key of keys) await kv.set(VIEW_PREFIX + key, trimmed);
      for (const entry of dropped) await kv.delete(VIEW_PREFIX + entry.key);
      await kv.set(VIEW_INDEX_KEY, next);
    });

  bb.rpc.register(rpcContract, {
    graph: ({ threadId, filter }) => graphFor(threadId, filter),
    labelsChanged: () => {
      labelIndex = null;
      buildCache.clear();
      bb.realtime.publish(GRAPH_CHANGED, { threadIds: [] } satisfies GraphChangedPayload);
      return { ok: true };
    },
    viewGet: async ({ key, fallbackKey }) => {
      const state = await readView(key);
      if (state) return { state, fromFallback: false };
      const fallback = fallbackKey ? await readView(fallbackKey) : null;
      return { state: fallback, fromFallback: fallback !== null };
    },
    viewSet: async ({ key, alsoKey, state }) => {
      await writeViews(alsoKey && alsoKey !== key ? [key, alsoKey] : [key], state);
      return { ok: true };
    },
    presetsList: () => readPresets(),
    presetSave: ({ name, state }) =>
      serialized(async () => {
        const presets = (await readPresets()).filter((preset) => preset.name !== name);
        presets.push({ name, state: trimState(state), savedAt: Date.now() });
        const kept = presets.slice(-MAX_PRESETS);
        await kv.set(PRESETS_KEY, kept);
        return kept;
      }),
    presetDelete: ({ name }) =>
      serialized(async () => {
        const kept = (await readPresets()).filter((preset) => preset.name !== name);
        await kv.set(PRESETS_KEY, kept);
        return kept;
      }),
  });

  // Live updates: coalesce thread changes and tell open graphs to refetch.
  // Streaming deltas are skipped; item start/complete events carry the
  // structural changes the graph draws.
  const pending = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = bb.sdk.subscribe({
    event: "thread:changed",
    callback: (event) => {
      const eventTypes = event.metadata?.eventTypes;
      if (
        eventTypes !== undefined &&
        eventTypes.length > 0 &&
        eventTypes.every((type) => DELTA_EVENTS.has(type))
      ) {
        return;
      }
      if (event.id) {
        timelineCache.delete(event.id);
        buildCache.clear();
        pending.add(event.id);
      }
      flushTimer ??= setTimeout(() => {
        flushTimer = null;
        const threadIds = [...pending];
        pending.clear();
        bb.realtime.publish(GRAPH_CHANGED, { threadIds } satisfies GraphChangedPayload);
      }, 600);
    },
  });
  // Ask Labels Pro to tell us about label changes, so the graph and its
  // label filter refresh when labels are assigned. Without it, labels still
  // refresh on the next thread change or the 15-second heartbeat.
  bb.sdk.plugins
    .callRpc({
      pluginId: LABELS_PLUGIN_ID,
      method: "subscribeChanges",
      input: { method: "labelsChanged" },
      outputSchema: z.unknown(),
    })
    .catch(() => {});
  bb.onDispose(() => {
    unsubscribe();
    if (flushTimer !== null) clearTimeout(flushTimer);
  });

  // `bb agent-graph [--thread <id>] [--json]`: the same graph as a tree, so
  // agents can see what their siblings and subagents are doing.
  const usage = [
    "Usage:",
    "  bb agent-graph [--thread <id>] [--hide <facet>=<value>]... [--json]",
    "",
    "--hide hides overview threads. Facets: project, label, kind, status,",
    "provider. Kinds: automation, task, child, manual. Example:",
    "  bb agent-graph --hide kind=automation --hide status=idle",
    "",
    "Prints the live agent graph: projects, threads, turns, tool calls,",
    "subagents and workflow agents, with their status.",
  ].join("\n");
  const glyph: Record<NodeStatus, string> = {
    running: "●",
    waiting: "◐",
    queued: "◌",
    done: "✓",
    error: "✗",
    interrupted: "■",
    idle: "○",
  };
  bb.cli.register({
    name: "agent-graph",
    summary: "Show a live graph of agents, subagents and their tool calls",
    commands: [
      {
        name: "show",
        summary: "Print the agent graph (default)",
        usage: "bb agent-graph [show] [--thread <id>] [--json]",
      },
    ],
    async run(argv) {
      if (argv.includes("--help") || argv.includes("help")) {
        return { exitCode: 0, stdout: usage };
      }
      const threadFlag = argv.indexOf("--thread");
      const threadId = threadFlag >= 0 ? (argv[threadFlag + 1] ?? null) : null;
      if (threadFlag >= 0 && threadId === null) {
        return { exitCode: 1, stderr: usage };
      }
      // `--hide kind=automation` (repeatable) hides overview threads, as
      // the Filter menu does.
      const filter: ThreadFilter = {};
      argv.forEach((arg, index) => {
        if (arg !== "--hide") return;
        const [key, ...rest] = (argv[index + 1] ?? "").split("=");
        const value = rest.join("=");
        if ((FACET_KEYS as readonly string[]).includes(key ?? "") && value) {
          const facet = key as (typeof FACET_KEYS)[number];
          (filter[facet] ??= []).push(value);
        }
      });
      const graph =
        threadId === null ? await buildOverview(filter) : await buildThread(threadId);
      if (argv.includes("--json")) {
        const text = JSON.stringify(graph);
        if (text.length > 900_000) {
          return {
            exitCode: 1,
            stderr: "Graph too large for --json; narrow it with --thread <id>.",
          };
        }
        return { exitCode: 0, stdout: text };
      }
      const children = new Map<string | null, GraphNode[]>();
      for (const node of graph.nodes) {
        const list = children.get(node.parentId) ?? [];
        list.push(node);
        children.set(node.parentId, list);
      }
      const lines: string[] = [];
      const walk = (node: GraphNode, prefix: string, last: boolean, top: boolean) => {
        const head = top ? "" : `${prefix}${last ? "└─ " : "├─ "}`;
        const sub = node.sublabel ? `  — ${node.sublabel}` : "";
        lines.push(`${head}${glyph[node.status]} ${node.label}${sub}`);
        const kids = children.get(node.id) ?? [];
        const nextPrefix = top ? "" : `${prefix}${last ? "   " : "│  "}`;
        kids.forEach((kid, index) =>
          walk(kid, nextPrefix, index === kids.length - 1, false),
        );
      };
      for (const root of children.get(null) ?? []) walk(root, "", true, true);
      let text = lines.join("\n");
      if (text.length > 60_000) text = `${text.slice(0, 60_000)}\n… (truncated)`;
      return { exitCode: 0, stdout: text || "No agent activity." };
    },
  });
}
