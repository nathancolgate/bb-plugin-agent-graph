// Pure tree layout for the agent graph: left-to-right tidy tree, parents
// centered on their visible children. No React, so it is easy to test.
import type { GraphNode, NodeStatus } from "./contract";

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 58;
export const COLUMN_GAP = 64;
export const ROW_GAP = 14;

export interface LaidOutNode {
  node: GraphNode;
  x: number;
  y: number;
  depth: number;
  childCount: number;
  collapsed: boolean;
  /** Status summary of hidden descendants when collapsed. */
  hidden: Partial<Record<NodeStatus, number>>;
}

export interface Edge {
  id: string;
  from: LaidOutNode;
  to: LaidOutNode;
}

export interface Layout {
  nodes: LaidOutNode[];
  edges: Edge[];
  width: number;
  height: number;
}

/** Plain tool calls shown per parent before older ones fold away. */
export const FOLD_AFTER = 8;
export const FOLD_SUFFIX = "::fold";
export const UNFOLD_SUFFIX = "::all";

const ACTIVE: ReadonlySet<NodeStatus> = new Set(["running", "waiting", "queued"]);

export function isActive(status: NodeStatus): boolean {
  return ACTIVE.has(status);
}

/** Map of parent id → children, in input order. */
export function childrenIndex(nodes: GraphNode[]): Map<string | null, GraphNode[]> {
  const ids = new Set(nodes.map((node) => node.id));
  const index = new Map<string | null, GraphNode[]>();
  for (const node of nodes) {
    // An orphan (parent filtered out) becomes a root rather than vanishing.
    const parent =
      node.parentId !== null && ids.has(node.parentId) ? node.parentId : null;
    const list = index.get(parent) ?? [];
    list.push(node);
    index.set(parent, list);
  }
  return index;
}

/**
 * Default collapse policy: finished turns, subagents and workflows fold
 * away, except each thread's newest turn, so the graph opens on what is
 * happening now.
 */
export function defaultCollapsed(
  node: GraphNode,
  siblings: GraphNode[],
  childCount: number,
): boolean {
  if (childCount === 0 || isActive(node.status)) return false;
  if (node.kind === "turn") {
    const turns = siblings.filter((sibling) => sibling.kind === "turn");
    return turns.at(-1)?.id !== node.id;
  }
  return node.kind === "subagent" || node.kind === "workflow";
}

/**
 * Fold all but the newest FOLD_AFTER plain tool calls into one synthetic
 * "+N earlier steps" node. Subagents, workflows and threads never fold.
 */
function foldKids(
  parent: GraphNode,
  kids: GraphNode[],
  overrides: ReadonlyMap<string, boolean>,
): GraphNode[] {
  if (overrides.get(parent.id + UNFOLD_SUFFIX)) return kids;
  const tools = kids.filter((kid) => kid.kind === "tool");
  const excess = tools.length - FOLD_AFTER;
  if (excess <= 1) return kids;
  const folded = new Set(
    tools.slice(0, excess).filter((kid) => !isActive(kid.status)).map((kid) => kid.id),
  );
  if (folded.size <= 1) return kids;
  const firstIndex = kids.findIndex((kid) => folded.has(kid.id));
  const placeholder: GraphNode = {
    id: parent.id + FOLD_SUFFIX,
    parentId: parent.id,
    kind: "more",
    label: `+${folded.size} earlier steps`,
    sublabel: "Click to show",
    status: "done",
    threadId: parent.threadId,
    startedAt: null,
    completedAt: null,
    input: null,
    output: null,
    meta: {},
  };
  const result = kids.filter((kid) => !folded.has(kid.id));
  result.splice(firstIndex, 0, placeholder);
  return result;
}

export function layoutGraph(
  nodes: GraphNode[],
  overrides: ReadonlyMap<string, boolean>,
): Layout {
  const index = childrenIndex(nodes);
  const laid: LaidOutNode[] = [];
  const edges: Edge[] = [];
  let cursorY = 0;
  let maxDepth = 0;

  const countHidden = (
    id: string,
    into: Partial<Record<NodeStatus, number>>,
  ) => {
    for (const child of index.get(id) ?? []) {
      into[child.status] = (into[child.status] ?? 0) + 1;
      countHidden(child.id, into);
    }
  };

  const place = (node: GraphNode, depth: number, siblings: GraphNode[]): LaidOutNode => {
    maxDepth = Math.max(maxDepth, depth);
    const kids = foldKids(node, index.get(node.id) ?? [], overrides);
    const collapsed =
      overrides.get(node.id) ?? defaultCollapsed(node, siblings, kids.length);
    const entry: LaidOutNode = {
      node,
      x: depth * (NODE_WIDTH + COLUMN_GAP),
      y: 0,
      depth,
      childCount: kids.length,
      collapsed,
      hidden: {},
    };
    laid.push(entry);
    if (kids.length === 0 || collapsed) {
      if (collapsed) countHidden(node.id, entry.hidden);
      entry.y = cursorY;
      cursorY += NODE_HEIGHT + ROW_GAP;
      return entry;
    }
    const placed = kids.map((kid) => place(kid, depth + 1, kids));
    const first = placed[0]!;
    const last = placed[placed.length - 1]!;
    entry.y = (first.y + last.y) / 2;
    for (const child of placed) {
      edges.push({ id: `${node.id}->${child.node.id}`, from: entry, to: child });
    }
    return entry;
  };

  const roots = index.get(null) ?? [];
  roots.forEach((root) => {
    place(root, 0, roots);
    cursorY += ROW_GAP * 2;
  });

  return {
    nodes: laid,
    edges,
    width: (maxDepth + 1) * (NODE_WIDTH + COLUMN_GAP),
    height: Math.max(cursorY, NODE_HEIGHT),
  };
}

/** Keep only active nodes and the chain of ancestors leading to them. */
export function filterActive(nodes: GraphNode[]): GraphNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const keep = new Set<string>();
  for (const node of nodes) {
    if (!isActive(node.status)) continue;
    let current: GraphNode | undefined = node;
    while (current && !keep.has(current.id)) {
      keep.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return nodes.filter((node) => keep.has(node.id));
}
