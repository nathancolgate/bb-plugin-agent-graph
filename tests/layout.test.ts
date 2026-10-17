import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphNode } from "../server.ts";
import {
  defaultCollapsed,
  filterActive,
  FOLD_AFTER,
  FOLD_SUFFIX,
  layoutGraph,
  UNFOLD_SUFFIX,
} from "../layout.ts";

function node(id: string, parentId: string | null, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    parentId,
    kind: "tool",
    label: id,
    sublabel: null,
    status: "done",
    threadId: "thr",
    startedAt: null,
    completedAt: null,
    input: null,
    output: null,
    meta: {},
    ...extra,
  };
}

test("centers a parent on its children, left to right", () => {
  const layout = layoutGraph(
    [node("root", null, { kind: "root" }), node("a", "root"), node("b", "root")],
    new Map(),
  );
  const [root, a, b] = layout.nodes;
  assert.equal(root!.x, 0);
  assert.ok(a!.x > root!.x);
  assert.equal(root!.y, (a!.y + b!.y) / 2);
  assert.equal(layout.edges.length, 2);
});

test("folds older tool calls into one expandable node", () => {
  const tools = Array.from({ length: FOLD_AFTER + 5 }, (_, i) => node(`t${i}`, "turn"));
  const nodes = [node("turn", null, { kind: "turn", status: "running" }), ...tools];
  const folded = layoutGraph(nodes, new Map());
  const placeholder = folded.nodes.find((item) => item.node.id === `turn${FOLD_SUFFIX}`);
  assert.ok(placeholder);
  assert.equal(placeholder.node.label, "+5 earlier steps");
  assert.equal(folded.nodes.length, 1 + FOLD_AFTER + 1);

  const unfolded = layoutGraph(nodes, new Map([[`turn${UNFOLD_SUFFIX}`, true]]));
  assert.equal(unfolded.nodes.length, nodes.length);
});

test("collapses finished turns except the newest, never active ones", () => {
  const t1 = node("t1", "thr", { kind: "turn" });
  const t2 = node("t2", "thr", { kind: "turn" });
  assert.equal(defaultCollapsed(t1, [t1, t2], 3), true);
  assert.equal(defaultCollapsed(t2, [t1, t2], 3), false);
  assert.equal(defaultCollapsed({ ...t1, status: "running" }, [t1, t2], 3), false);
  assert.equal(defaultCollapsed(t1, [t1, t2], 0), false);
});

test("active-only keeps running work and its ancestors", () => {
  const kept = filterActive([
    node("root", null, { kind: "root" }),
    node("idle", "root"),
    node("busy", "root", { kind: "thread" }),
    node("tool", "busy", { status: "running" }),
  ]);
  assert.deepEqual(kept.map((n) => n.id), ["root", "busy", "tool"]);
});

test("an expanded baseline opens finished work and unfolds long runs", () => {
  const nodes = [
    node("thread", null, { kind: "thread" }),
    node("t1", "thread", { kind: "turn" }),
    node("t1-tool", "t1"),
    node("t2", "thread", { kind: "turn" }),
    ...Array.from({ length: FOLD_AFTER + 3 }, (_, i) => node(`tool${String(i)}`, "t2")),
  ];
  const byDefault = layoutGraph(nodes, new Map());
  assert.equal(byDefault.nodes.find((item) => item.node.id === "t1")!.collapsed, true);
  assert.ok(byDefault.nodes.some((item) => item.node.id === "t2" + FOLD_SUFFIX));

  const expanded = layoutGraph(nodes, new Map(), "expanded");
  assert.equal(expanded.nodes.find((item) => item.node.id === "t1")!.collapsed, false);
  assert.ok(!expanded.nodes.some((item) => item.node.kind === "more"));
  assert.equal(expanded.nodes.length, nodes.length);
});

test("a collapsed baseline closes every parent, and per-node choices win", () => {
  const nodes = [
    node("thread", null, { kind: "thread" }),
    node("t1", "thread", { kind: "turn", status: "running" }),
    node("t1-tool", "t1", { status: "running" }),
  ];
  const collapsed = layoutGraph(nodes, new Map(), "collapsed");
  assert.deepEqual(collapsed.nodes.map((item) => item.node.id), ["thread"]);
  assert.equal(collapsed.nodes[0]!.hidden.running, 2);

  const opened = layoutGraph(nodes, new Map([["thread", false]]), "collapsed");
  assert.deepEqual(
    opened.nodes.map((item) => [item.node.id, item.collapsed]),
    [["thread", false], ["t1", true]],
  );
});
