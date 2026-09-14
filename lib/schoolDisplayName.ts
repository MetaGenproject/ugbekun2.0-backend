const GENERIC_SCHOOL_NAMES = new Set([
  'ugbekun international academy',
  'school dashboard',
  'ugbekun schools',
  'ugbekun',
]);

export function resolveDisplaySchoolName(
  settingsName?: string | null,
  branchName?: string | null
): string {
  const setting = String(settingsName || '').trim();
  const branch = String(branchName || '').trim();
  if (branch && (!setting || GENERIC_SCHOOL_NAMES.has(setting.toLowerCase()))) {
    return branch;
  }
  return setting || branch || 'School Dashboard';
}
