import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildFacets,
  hiddenCount,
  isHidden,
  NO_LABEL,
  normalizeFilter,
  threadKind,
  type ThreadFacts,
} from "../filters.ts";

function facts(extra: Partial<ThreadFacts> = {}): ThreadFacts {
  return { project: "p1", labels: [], kind: "manual", status: "idle", provider: "claude", ...extra };
}

test("classifies automation, task, subthread and other threads", () => {
  const base = { originPluginId: null, parentThreadId: null, title: "Fix the build", labelSlugs: [] };
  assert.equal(threadKind({ ...base, originPluginId: "automations" }), "automation");
  assert.equal(threadKind({ ...base, labelSlugs: ["automation"], parentThreadId: "thr_p" }), "automation");
  assert.equal(threadKind({ ...base, title: "JOBS-12 · Add the careers page" }), "task");
  assert.equal(threadKind({ ...base, parentThreadId: "thr_p" }), "child");
  assert.equal(threadKind(base), "manual");
});

test("hides a thread when any one of its values is hidden", () => {
  assert.equal(isHidden(facts(), {}), false);
  assert.equal(isHidden(facts({ kind: "automation" }), { kind: ["automation"] }), true);
  assert.equal(isHidden(facts({ labels: ["a", "b"] }), { label: ["b"] }), true);
  assert.equal(isHidden(facts({ labels: ["a"] }), { label: ["b"] }), false);
  assert.equal(isHidden(facts(), { label: [NO_LABEL] }), true);
  assert.equal(isHidden(facts({ labels: ["a"] }), { label: [NO_LABEL] }), false);
});

test("counts every value and keeps hidden values that are gone", () => {
  const facets = buildFacets(
    [facts({ labels: ["a"] }), facts({ project: "p2", labels: ["a", "b"] }), facts()],
    { project: ["p9"] },
    {
      project: (id) => (id === "p1" ? "Claude env" : id),
      label: (id) => ({ name: id.toUpperCase(), color: "#f00" }),
    },
  );
  assert.deepEqual(
    facets.project.map((item) => [item.label, item.count]),
    [["Claude env", 2], ["p2", 1], ["p9", 0]],
  );
  assert.deepEqual(
    facets.label.map((item) => [item.value, item.count]),
    [["a", 2], ["b", 1], [NO_LABEL, 1]],
  );
  assert.equal(facets.label[0]!.label, "A");
});

test("normalizes filters for caching and counts hidden values", () => {
  assert.deepEqual(normalizeFilter({ kind: ["task", "automation", "task"], label: [] }), {
    kind: ["automation", "task"],
  });
  assert.equal(hiddenCount({ kind: ["task"], project: ["p1", "p2"] }), 3);
});
