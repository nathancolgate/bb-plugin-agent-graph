// Thread filters for the overview: which threads to hide by project, label,
// thread type, status and provider. Pure, so the backend and the tests share
// it; the frontend only imports its types and labels.

export const FACET_KEYS = ["project", "label", "kind", "status", "provider"] as const;
export type FacetKey = (typeof FACET_KEYS)[number];

export const FACET_LABEL: Record<FacetKey, string> = {
  project: "Projects",
  label: "Labels",
  kind: "Thread type",
  status: "Status",
  provider: "Provider",
};

/**
 * Hidden values per facet. A hide list rather than a show list, so projects
 * and labels that appear later are shown until the user hides them.
 */
export type ThreadFilter = Partial<Record<FacetKey, string[]>>;

export interface FacetValue {
  value: string;
  label: string;
  /** Threads in the overview window with this value, before filtering. */
  count: number;
  color?: string | null;
}
export type Facets = Record<FacetKey, FacetValue[]>;

/** Facet values of one thread. A thread can carry many labels. */
export interface ThreadFacts {
  project: string;
  labels: string[];
  kind: string;
  status: string;
  provider: string;
}

/** The label value of a thread with no labels. */
export const NO_LABEL = "none";

export const KIND_NAMES: Record<string, string> = {
  automation: "Automations",
  task: "Task threads",
  child: "Subthreads",
  manual: "Other threads",
};
export const STATUS_NAMES: Record<string, string> = {
  running: "Running",
  waiting: "Needs input",
  queued: "Queued",
  error: "Error",
  idle: "Idle",
};

/** A task key at the start of a title, as task dispatch writes it: `SIDE-1 · …`. */
const TASK_KEY_IN_TITLE = /^([A-Za-z][A-Za-z0-9]*-\d+)\b/;

/**
 * One type per thread, most specific first: an automation run, a thread
 * started for a task, a subthread of another thread, or anything else.
 */
export function threadKind(thread: {
  originPluginId?: string | null;
  parentThreadId: string | null;
  title: string | null;
  labelSlugs: string[];
}): string {
  if (thread.originPluginId === "automations" || thread.labelSlugs.includes("automation")) {
    return "automation";
  }
  if (TASK_KEY_IN_TITLE.test((thread.title ?? "").trim())) return "task";
  if (thread.parentThreadId) return "child";
  return "manual";
}

export function normalizeFilter(filter: ThreadFilter | null | undefined): ThreadFilter {
  const result: ThreadFilter = {};
  for (const key of FACET_KEYS) {
    const values = filter?.[key];
    if (values && values.length > 0) result[key] = [...new Set(values)].sort();
  }
  return result;
}

export function hiddenCount(filter: ThreadFilter | null | undefined): number {
  return FACET_KEYS.reduce((sum, key) => sum + (filter?.[key]?.length ?? 0), 0);
}

/** A thread is hidden when any of its values is hidden; for labels, any one label. */
export function isHidden(facts: ThreadFacts, filter: ThreadFilter): boolean {
  const hides = (key: FacetKey, value: string) => filter[key]?.includes(value) ?? false;
  if (hides("project", facts.project)) return true;
  if (hides("kind", facts.kind)) return true;
  if (hides("status", facts.status)) return true;
  if (hides("provider", facts.provider)) return true;
  const labels = facts.labels.length > 0 ? facts.labels : [NO_LABEL];
  return labels.some((label) => hides("label", label));
}

/**
 * Every value seen in the window, with counts, plus hidden values that are
 * no longer seen (count 0), so the user can always show them again.
 */
export function buildFacets(
  facts: ThreadFacts[],
  filter: ThreadFilter,
  names: {
    project: (id: string) => string;
    label: (id: string) => { name: string; color: string | null } | null;
  },
): Facets {
  const counts = Object.fromEntries(
    FACET_KEYS.map((key) => [key, new Map<string, number>()]),
  ) as Record<FacetKey, Map<string, number>>;
  const bump = (key: FacetKey, value: string) =>
    counts[key].set(value, (counts[key].get(value) ?? 0) + 1);
  for (const thread of facts) {
    bump("project", thread.project);
    bump("kind", thread.kind);
    bump("status", thread.status);
    bump("provider", thread.provider);
    for (const label of thread.labels.length > 0 ? thread.labels : [NO_LABEL]) {
      bump("label", label);
    }
  }
  for (const key of FACET_KEYS) {
    for (const value of filter[key] ?? []) {
      if (!counts[key].has(value)) counts[key].set(value, 0);
    }
  }
  const describe = (key: FacetKey, value: string): Omit<FacetValue, "count"> => {
    switch (key) {
      case "project":
        return { value, label: names.project(value) };
      case "label": {
        if (value === NO_LABEL) return { value, label: "No label" };
        const label = names.label(value);
        return { value, label: label?.name ?? value, color: label?.color ?? null };
      }
      case "kind":
        return { value, label: KIND_NAMES[value] ?? value };
      case "status":
        return { value, label: STATUS_NAMES[value] ?? value };
      case "provider":
        return { value, label: value || "Unknown" };
    }
  };
  return Object.fromEntries(
    FACET_KEYS.map((key) => [
      key,
      [...counts[key]]
        .map(([value, count]) => ({ ...describe(key, value), count }))
        // Most threads first; "No label" last among labels.
        .sort(
          (a, b) =>
            Number(a.value === NO_LABEL) - Number(b.value === NO_LABEL) ||
            b.count - a.count ||
            a.label.localeCompare(b.label),
        ),
    ]),
  ) as Facets;
}
