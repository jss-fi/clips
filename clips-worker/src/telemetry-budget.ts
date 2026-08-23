const TELEMETRY_WRITE_BUDGET_PER_MINUTE = 300;
const WINDOW_MS = 60 * 1000;

type TelemetryBudget = { windowId: number; used: number };
type TelemetryBudgetDecision = { accepted: boolean; budget: TelemetryBudget };

function nextTelemetryBudget(
  current: TelemetryBudget | null,
  now: number,
  writeCost: number,
  limit = TELEMETRY_WRITE_BUDGET_PER_MINUTE
): TelemetryBudgetDecision {
  const windowId = Math.floor(now / WINDOW_MS);
  const used = current?.windowId === windowId ? current.used : 0;
  if (!Number.isInteger(writeCost) || writeCost < 1 || used + writeCost > limit) {
    return { accepted: false, budget: { windowId, used } };
  }
  return { accepted: true, budget: { windowId, used: used + writeCost } };
}

export { TELEMETRY_WRITE_BUDGET_PER_MINUTE, nextTelemetryBudget };
