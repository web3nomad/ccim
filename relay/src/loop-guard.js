// Invalid configuration must not silently disable the upstream safety limit.
export function loopGuardMax(value) {
  if (value === undefined || value === null || !/^\d+$/.test(String(value))) return 256;
  const max = Number(value);
  return Number.isSafeInteger(max) ? max : 256;
}
