/**
 * Default SaaS subscription plans — aligned with marketing pricing and
 * legacy onboarding (e.g. Basic Plus, ₦80,000 / 3 months).
 */
const DEFAULT_PLANS = [
  {
    slug: 'starter',
    name: 'Starter',
    description: 'Perfect for small schools — up to 500 students',
    priceMonthly: 50000,
    durationMonths: 1,
    totalCost: 50000,
  },
  {
    slug: 'professional',
    name: 'Professional',
    description: 'Most popular for medium schools — up to 2,000 students',
    priceMonthly: 150000,
    durationMonths: 1,
    totalCost: 150000,
  },
  {
    slug: 'basic-plus',
    name: 'Basic Plus',
    description: 'Quarterly plan for growing schools',
    priceMonthly: 26666.67,
    durationMonths: 3,
    totalCost: 80000,
  },
  {
    slug: 'enterprise',
    name: 'Enterprise',
    description: 'Custom pricing for large school networks',
    priceMonthly: 0,
    durationMonths: 12,
    totalCost: 0,
  },
];

/** Map frontend pricing card names to plan slugs */
const PLAN_SLUG_ALIASES = {
  starter: 'starter',
  professional: 'professional',
  enterprise: 'enterprise',
  'basic-plus': 'basic-plus',
  'basic plus': 'basic-plus',
  trial: 'professional',
};

function resolvePlanSlug(input) {
  if (!input) return 'professional';
  const key = String(input).trim().toLowerCase();
  return PLAN_SLUG_ALIASES[key] || key;
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function formatPlanDate(date) {
  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

module.exports = {
  DEFAULT_PLANS,
  PLAN_SLUG_ALIASES,
  resolvePlanSlug,
  addMonths,
  formatPlanDate,
};
