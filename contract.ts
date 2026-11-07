// RPC contract shared by the backend (server.ts) and the frontend (app.tsx,
// graph.tsx). The frontend reads the graph through it, so keep it free of
// server-only imports.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

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

const graphSchema = z.object({
  nodes: z.array(graphNodeSchema),
  generatedAt: z.number(),
  truncated: z.boolean(),
});
export type Graph = z.infer<typeof graphSchema>;

/** Tag of the overview graph, refreshed on any thread change. */
export const OVERVIEW_TAG = "overview";
/** Tag of every thread graph that shows this thread. */
export function threadTag(threadId: string): string {
  return `thread:${threadId}`;
}

export const rpcContract = defineRpcContract({
  graph: {
    input: z.object({
      threadId: z.string().nullable(),
    }),
    output: graphSchema,
    tags: ({ threadId }, graph) => {
      if (threadId === null) return [OVERVIEW_TAG];
      const shown = new Set([threadId]);
      for (const node of graph.nodes) {
        if (node.threadId !== null) shown.add(node.threadId);
      }
      return [...shown].map(threadTag);
    },
  },
});
