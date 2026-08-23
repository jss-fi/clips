import { serve as serveUpdates } from './updates';
import { serveTelemetry } from './telemetry';

export { TelemetryAdmission } from './telemetry-admission';

function withoutPrefix(request: Request, prefix: string): Request {
  const url = new URL(request.url);
  url.pathname = url.pathname.slice(prefix.length) || '/';
  return new Request(url, request);
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname === env.LEGACY_UPDATE_DOMAIN) {
      url.hostname = env.PRIMARY_DOMAIN;
      url.pathname = `${env.UPDATE_PATH}${url.pathname}`;
      return Response.redirect(url, 308);
    }
    if (url.hostname === env.LEGACY_TELEMETRY_DOMAIN) {
      url.hostname = env.PRIMARY_DOMAIN;
      url.pathname = `${env.TELEMETRY_PATH}${url.pathname}`;
      return Response.redirect(url, 308);
    }
    const pathname = url.pathname;
    if (pathname === '/cdn' || pathname.startsWith('/cdn/')) {
      return serveUpdates(withoutPrefix(request, '/cdn'), env.UPDATES);
    }
    if (pathname === '/telemetry' || pathname.startsWith('/telemetry/')) {
      return serveTelemetry(withoutPrefix(request, '/telemetry'), env.TELEMETRY, {
        client: env.TELEMETRY_CLIENT_RATE_LIMIT,
        service: env.TELEMETRY_SERVICE_RATE_LIMIT,
        admission: env.TELEMETRY_ADMISSION
      });
    }
    if (pathname === '/download' || pathname === '/download/' || pathname === '/download/stable' || pathname === '/download/setup') {
      const metadata = await env.UPDATES.get('releases/stable/latest.yml');
      const version = metadata && /^version:\s*([^\r\n]+)$/m.exec(await metadata.text())?.[1]?.trim();
      if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
        return new Response('The Windows download is temporarily unavailable.', { status: 503 });
      }
      const installer = `jss-clips-setup-${version}-x64.exe`;
      return new Response(null, {
        status: 307,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
          Location: new URL(`/cdn/stable/${installer}`, request.url).toString()
        }
      });
    }
    if (pathname === '/source') {
      const metadata = await env.UPDATES.get('releases/latest.json');
      const version = metadata ? String((await metadata.json<{ version?: unknown }>()).version || '') : '';
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
        return new Response('The corresponding source is temporarily unavailable.', { status: 503 });
      }
      return Response.redirect(new URL(`/cdn/jss-clips-source-${version}.zip`, request.url), 307);
    }
    if (pathname === '/app' || pathname.startsWith('/app/')) {
      return new Response('The Clips browser demo has been removed.', {
        status: 410,
        headers: { 'Cache-Control': 'no-store, max-age=0', 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
    return Response.redirect(new URL('/download/', request.url), 307);
  }
} satisfies ExportedHandler<Env>;
