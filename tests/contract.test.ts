import { test } from "node:test";
import assert from "node:assert/strict";
import { OVERVIEW_TAG, rpcContract, threadTag, type Graph, type GraphNode } from "../contract.ts";

function node(id: string, threadId: string | null): GraphNode {
  return {
    id,
    parentId: null,
    kind: "thread",
    label: id,
    sublabel: null,
    status: "idle",
    threadId,
    startedAt: null,
    completedAt: null,
    input: null,
    output: null,
    meta: {},
  };
}

function graph(nodes: GraphNode[]): Graph {
  return { nodes, generatedAt: 0, truncated: false };
}

test("tags the overview with one tag that every thread change invalidates", () => {
  const tags = rpcContract.graph.tags!({ threadId: null }, graph([node("thr_a", "thr_a")]));
  assert.deepEqual(tags, [OVERVIEW_TAG]);
});

test("tags a thread graph with every thread it shows, once each", () => {
  const tags = rpcContract.graph.tags!(
    { threadId: "thr_root" },
    graph([
      node("thr_root", "thr_root"),
      node("thr_root:turn:1", "thr_root"),
      node("thr_child", "thr_child"),
      node("thr_child:turn:1", "thr_child"),
      node("root", null),
    ]),
  );
  assert.deepEqual(tags, [threadTag("thr_root"), threadTag("thr_child")]);
});

test("tags a thread graph with its own thread before its first build has nodes", () => {
  const tags = rpcContract.graph.tags!({ threadId: "thr_root" }, graph([]));
  assert.deepEqual(tags, [threadTag("thr_root")]);
});
