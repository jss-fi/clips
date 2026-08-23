import { DurableObject } from 'cloudflare:workers';
import { nextTelemetryBudget } from './telemetry-budget';

type StoredTelemetryBudget = { windowId: number; used: number };

export class TelemetryAdmission extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_budget (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          window_id INTEGER NOT NULL,
          used INTEGER NOT NULL
        )
      `);
    });
  }

  async admit(writeCost: number): Promise<boolean> {
    // Keep the strongly consistent read and write in one RPC turn with no awaited I/O between them.
    const current = this.ctx.storage.sql.exec<StoredTelemetryBudget>(
      'SELECT window_id AS windowId, used FROM telemetry_budget WHERE id = 1'
    ).toArray()[0] || null;
    const decision = nextTelemetryBudget(current, Date.now(), writeCost);
    if (!decision.accepted) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO telemetry_budget (id, window_id, used) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET window_id = excluded.window_id, used = excluded.used`,
      decision.budget.windowId,
      decision.budget.used
    );
    return true;
  }
}
