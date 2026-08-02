import type { PlanNode } from "../contracts.ts";

export interface DagValidationResult {
  valid: boolean;
  errors: string[];
  topologicalOrder: string[];
}

interface TopologyResult {
  order: string[];
  cycle: string[];
}

function computeTopology(nodes: readonly PlanNode[]): TopologyResult {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const node of nodes) {
    indegree.set(node.id, node.dependencies.filter((dependency) => byId.has(dependency)).length);
    for (const dependency of node.dependencies) {
      if (!byId.has(dependency)) continue;
      const entries = dependents.get(dependency) ?? [];
      entries.push(node.id);
      dependents.set(dependency, entries);
    }
  }

  const inputOrder = new Map(nodes.map((node, index) => [node.id, index]));
  const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort((left, right) => (inputOrder.get(left) ?? 0) - (inputOrder.get(right) ?? 0));
    const id = ready.shift();
    if (!id) break;
    order.push(id);

    for (const dependent of dependents.get(id) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  return {
    order,
    cycle: nodes.map(({ id }) => id).filter((id) => !order.includes(id)),
  };
}

/** Validates identity, references, budgets, route ownership, and acyclicity. */
export function validateDag(nodes: readonly PlanNode[]): DagValidationResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!node.id.trim()) errors.push("A plan node has an empty id");
    if (seen.has(node.id)) errors.push(`Duplicate plan node id: ${node.id}`);
    seen.add(node.id);
  }

  for (const node of nodes) {
    if (!node.title.trim()) errors.push(`Node ${node.id || "<empty>"} has an empty title`);
    if (!node.objective.trim()) errors.push(`Node ${node.id || "<empty>"} has an empty objective`);
    if (!node.expectedArtifact.description.trim()) {
      errors.push(`Node ${node.id || "<empty>"} has no artifact description`);
    }
    if (node.routeRequest.stepId !== node.id) {
      errors.push(`Node ${node.id} routeRequest.stepId must equal its node id`);
    }
    if (node.dependencies.includes(node.id)) errors.push(`Node ${node.id} depends on itself`);
    if (new Set(node.dependencies).size !== node.dependencies.length) {
      errors.push(`Node ${node.id} has duplicate dependencies`);
    }
    for (const dependency of node.dependencies) {
      if (!seen.has(dependency))
        errors.push(`Node ${node.id} depends on missing node ${dependency}`);
    }
    if (node.contextBudget <= 0 || !Number.isFinite(node.contextBudget)) {
      errors.push(`Node ${node.id} contextBudget must be greater than zero`);
    }
    if (node.outputBudget <= 0 || !Number.isFinite(node.outputBudget)) {
      errors.push(`Node ${node.id} outputBudget must be greater than zero`);
    }
    if (node.maxCostUsd <= 0 || !Number.isFinite(node.maxCostUsd)) {
      errors.push(`Node ${node.id} maxCostUsd must be greater than zero`);
    }
    if (!Number.isInteger(node.maxAttempts) || node.maxAttempts < 1) {
      errors.push(`Node ${node.id} maxAttempts must be a positive integer`);
    }
    if (node.qualityFloor < 0 || node.qualityFloor > 1) {
      errors.push(`Node ${node.id} qualityFloor must be between 0 and 1`);
    }
    if (node.verification.minimumScore < 0 || node.verification.minimumScore > 1) {
      errors.push(`Node ${node.id} verification.minimumScore must be between 0 and 1`);
    }
  }

  const topology = computeTopology(nodes);
  if (topology.cycle.length > 0 && topology.order.length < nodes.length) {
    errors.push(`Plan contains a dependency cycle involving: ${topology.cycle.join(", ")}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    topologicalOrder: topology.order,
  };
}

export function assertValidDag(nodes: readonly PlanNode[]): void {
  const validation = validateDag(nodes);
  if (!validation.valid)
    throw new Error(`Invalid execution DAG:\n- ${validation.errors.join("\n- ")}`);
}

/** Returns a stable dependency order and throws for malformed or cyclic DAGs. */
export function topologicalSort(nodes: readonly PlanNode[]): PlanNode[] {
  const validation = validateDag(nodes);
  if (!validation.valid)
    throw new Error(`Cannot sort invalid execution DAG:\n- ${validation.errors.join("\n- ")}`);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return validation.topologicalOrder.map((id) => {
    const node = byId.get(id);
    if (!node) throw new Error(`Topological sort lost node ${id}`);
    return node;
  });
}
