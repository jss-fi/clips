import { TelemetryAdmission } from '../src/telemetry-admission';

interface IntegrationEnv {
  TELEMETRY_ADMISSION: DurableObjectNamespace<TelemetryAdmission>;
}

export { TelemetryAdmission };

export default {
  async fetch(request: Request, env: IntegrationEnv): Promise<Response> {
    const input = await request.json<{ name?: unknown; costs?: unknown }>();
    const name = typeof input.name === 'string' && /^[a-z0-9-]{1,80}$/.test(input.name) ? input.name : '';
    const costs = Array.isArray(input.costs) ? input.costs : [];
    if (!name || costs.length > 400 || costs.some(cost => !Number.isInteger(cost) || Number(cost) < 1)) {
      return Response.json({ error: 'Invalid integration request' }, { status: 400 });
    }
    const admission = env.TELEMETRY_ADMISSION.getByName(name);
    const accepted = await Promise.all(costs.map(cost => admission.admit(Number(cost))));
    return Response.json({ accepted });
  }
} satisfies ExportedHandler<IntegrationEnv>;
