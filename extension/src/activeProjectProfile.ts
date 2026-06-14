import type { FeatureKey } from "./featureFlags";

let activeTierFeatures: Partial<Record<FeatureKey, boolean>> | null = null;
let applyTierFeatures = true;

export function setActiveProjectProfileContext(
  features: Partial<Record<FeatureKey, boolean>> | null,
  apply: boolean
): void {
  activeTierFeatures = features;
  applyTierFeatures = apply;
}

export function getProjectProfileFeatureOverride(key: FeatureKey): boolean | undefined {
  if (!applyTierFeatures || !activeTierFeatures || !(key in activeTierFeatures)) {
    return undefined;
  }
  return activeTierFeatures[key];
}

export function resetActiveProjectProfileContextForTests(): void {
  activeTierFeatures = null;
  applyTierFeatures = true;
}
