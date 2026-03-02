// api/src/plans.ts
// Plan configuration types and default plans

export interface PlanLimits {
  runs_per_day: number;          // -1 = unlimited
  max_concurrent: number;
  max_tokens_per_run: number;    // -1 = unlimited
  rate_limit_per_minute: number;
}

export type PlansConfig = Record<string, PlanLimits>;

export const DEFAULT_PLANS: PlansConfig = {
  free: {
    runs_per_day: 5,
    max_concurrent: 1,
    max_tokens_per_run: 50_000,
    rate_limit_per_minute: 10,
  },
  pro: {
    runs_per_day: 100,
    max_concurrent: 5,
    max_tokens_per_run: 500_000,
    rate_limit_per_minute: 60,
  },
  unlimited: {
    runs_per_day: -1,
    max_concurrent: 20,
    max_tokens_per_run: -1,
    rate_limit_per_minute: 300,
  },
};

/** Merge user-supplied partial plans with defaults. Unknown plans fall back to 'free'. */
export function resolvePlans(configPlans?: Partial<PlansConfig>): PlansConfig {
  if (!configPlans) return DEFAULT_PLANS;
  return { ...DEFAULT_PLANS, ...configPlans } as PlansConfig;
}

/** Get plan limits for a user, defaulting to 'free' if plan is unknown. */
export function getPlanLimits(plans: PlansConfig, planName: string): PlanLimits {
  return plans[planName] ?? plans['free'] ?? DEFAULT_PLANS['free'];
}
