/**
 * Default SaaS subscription plans — aligned with marketing pricing and
 * legacy onboarding (e.g. Basic Plus, ₦80,000 / 3 months).
 */
export const DEFAULT_PLANS = [
  {
    slug: 'starter',
    name: 'Starter',
    description: 'Perfect for small schools — up to 500 students',
    priceMonthly: 50000,
    durationMonths: 1,
    totalCost: 50000,
    currency: 'NGN',
  },
  {
    slug: 'professional',
    name: 'Professional',
    description: 'Most popular for medium schools — up to 2,000 students',
    priceMonthly: 150000,
    durationMonths: 1,
    totalCost: 150000,
    currency: 'NGN',
  },
  {
    slug: 'basic-plus',
    name: 'Basic Plus',
    description: 'Quarterly plan for growing schools',
    priceMonthly: 26666.67,
    durationMonths: 3,
    totalCost: 80000,
    currency: 'NGN',
  },
  {
    slug: 'enterprise',
    name: 'Enterprise',
    description: 'Custom pricing for large school networks',
    priceMonthly: 0,
    durationMonths: 12,
    totalCost: 0,
    currency: 'NGN',
  },
];

/** Map frontend pricing card names to plan slugs */
export const PLAN_SLUG_ALIASES: Record<string, string> = {
  starter: 'starter',
  professional: 'professional',
  enterprise: 'enterprise',
  'basic-plus': 'basic-plus',
  'basic plus': 'basic-plus',
  trial: 'professional',
};

export function resolvePlanSlug(input?: string | null): string {
  if (!input) return 'professional';
  const key = String(input).trim().toLowerCase();
  return PLAN_SLUG_ALIASES[key] || key;
}

export function addMonths(date: Date | string | number, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

export function formatPlanDate(date: Date | string | number): string {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

export default {
  DEFAULT_PLANS,
  PLAN_SLUG_ALIASES,
  resolvePlanSlug,
  addMonths,
  formatPlanDate,
};
