export interface ProviderScopedCapability {
  providers?: readonly string[];
}

/** An omitted scope is neutral; an explicitly empty or mismatched scope is fail-closed. */
export function capabilitySupportsProvider(
  capability: ProviderScopedCapability,
  provider: string,
): boolean {
  return capability.providers === undefined || capability.providers.includes(provider);
}
