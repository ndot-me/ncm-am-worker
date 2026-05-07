import type { Env, SyncSession } from './types';
import {
  createSession,
  getSession,
  saveSession,
  phase1,
  phase2,
  phase3,
  phase4,
  phase5,
  manualSearch,
  skipToPhase3,
} from './sync';
import { checkLogin, refreshLoginRaw, qrLoginCreateKey, qrLoginUrl, qrLoginCheck } from './ncm';
import { searchSong } from './apple-music';
import { generateVapidKeys, sendPushNotification } from './web-push';
import { SW_JS, subscribeHtml } from './static';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: corsHeaders });
}

// ── Auth middleware ──

function checkToken(url: URL, env: Env): boolean {
  const token = url.searchParams.get('token');
  return token === env.SYNC_TOKEN;
}

// ── Push notification helpers ──

async function getVapidKeys(env: Env): Promise<{ publicKey: string; privateKey: string }> {
  const existing = await env.KV.get('vapid_keys', 'json');
  if (existing) return existing as { publicKey: string; privateKey: string };
  const keys = await generateVapidKeys();
  await env.KV.put('vapid_keys', JSON.stringify(keys));
  return keys;
}

async function notifySubscribers(env: Env, title: string, body: string, type: 'success' | 'error') {
  const vapidKeys = await getVapidKeys(env);
  const subsRaw = await env.KV.get('push_subscriptions', 'json');
  const subs: { endpoint: string; keys: { p256dh: string; auth: string } }[] =
    (subsRaw as any[]) || [];

  const payload = JSON.stringify({ title, body, type, tag: 'ncm-am-sync', url: '/' });
  const expired: string[] = [];
  for (const sub of subs) {
    const ok = await sendPushNotification(sub, payload, vapidKeys.publicKey, vapidKeys.privateKey);
    if (!ok) expired.push(sub.endpoint);
  }
  if (expired.length > 0) {
    const remaining = subs.filter(s => !expired.includes(s.endpoint));
    await env.KV.put('push_subscriptions', JSON.stringify(remaining));
  }
}

export default {
  // ── Cron trigger (legacy, now just logs — sync is manual via web UI) ──
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log(`[${new Date().toISOString()}] Cron triggered — sync is now manual via web UI`);
  },

  // ── HTTP handler ──
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── Serve frontend ──
    if (path === '/' || path === '/index.html') {
      const { frontendHtml } = await import('./static');
      return new Response(frontendHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }

    // ── Service worker ──
    if (path === '/sw.js') {
      return new Response(SW_JS, {
        headers: { 'Content-Type': 'application/javascript', ...corsHeaders },
      });
    }

    // ── Subscribe page (legacy) ──
    if (path === '/subscribe' && request.method === 'GET') {
      const vapidKeys = await getVapidKeys(env);
      return new Response(subscribeHtml(vapidKeys.publicKey), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders },
      });
    }

    // ── VAPID public key ──
    if (path === '/vapid-key' && request.method === 'GET') {
      const keys = await getVapidKeys(env);
      return json({ publicKey: keys.publicKey });
    }

    // ── Push subscribe ──
    if (path === '/subscribe' && request.method === 'POST') {
      try {
        const sub = await request.json() as any;
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
          return json({ error: 'Invalid subscription' }, 400);
        }
        const existing: any[] = ((await env.KV.get('push_subscriptions', 'json')) as any[]) || [];
        const filtered = existing.filter(s => s.endpoint !== sub.endpoint);
        filtered.push({ endpoint: sub.endpoint, keys: sub.keys });
        await env.KV.put('push_subscriptions', JSON.stringify(filtered));
        return json({ ok: true, count: filtered.length });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Push unsubscribe ──
    if (path === '/subscribe' && request.method === 'DELETE') {
      try {
        const { endpoint } = await request.json() as any;
        const existing: any[] = ((await env.KV.get('push_subscriptions', 'json')) as any[]) || [];
        const filtered = existing.filter(s => s.endpoint !== endpoint);
        await env.KV.put('push_subscriptions', JSON.stringify(filtered));
        return json({ ok: true, count: filtered.length });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // ── Login status ──
    if (path === '/status' && request.method === 'GET') {
      let cookie = env.NCM_COOKIE;
      const savedCookie = await env.KV.get('ncm_cookie');
      if (savedCookie) cookie = savedCookie;

      let ncmStatus: { ok: boolean; uid?: string; nickname?: string; error?: string };
      try {
        ncmStatus = await checkLogin(cookie);
      } catch (e: any) {
        ncmStatus = { ok: false, error: e.message };
      }

      let refreshed = false;
      if (!ncmStatus.ok) {
        const newCookie = await refreshLoginRaw(cookie);
        if (newCookie) {
          const recheck = await checkLogin(newCookie);
          if (recheck.ok) {
            await env.KV.put('ncm_cookie', newCookie, { expirationTtl: 86400 * 60 });
            ncmStatus = recheck;
            refreshed = true;
          }
        }
      }

      return json({
        ncm: { ...ncmStatus, refreshed },
        push: { subscribers: ((await env.KV.get('push_subscriptions', 'json')) as any[] || []).length },
      });
    }

    // ── QR Login ──
    if (path === '/login' && request.method === 'GET') {
      try {
        const key = await qrLoginCreateKey();
        const qrUrl = qrLoginUrl(key);
        await env.KV.put(`qr_key:${key}`, 'pending', { expirationTtl: 300 });
        return json({ ok: true, key, qrUrl });
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    if (path === '/login/check' && request.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!key) return json({ error: 'Missing ?key=' }, 400);
      try {
        const result = await qrLoginCheck(key);
        if (result.code === 803 && result.cookie) {
          await env.KV.put('ncm_cookie', result.cookie, { expirationTtl: 86400 * 60 });
          await env.KV.delete(`qr_key:${key}`);
          return json({ code: 803, status: 'success', message: '✅ 登录成功' });
        }
        return json({ code: result.code, message: result.message });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    // ══════════════════════════════════════════════
    // ── Sync API (token required) ──
    // ══════════════════════════════════════════════

    if (path === '/sync') {
      // All /sync endpoints require token
      if (!checkToken(url, env)) {
        return json({ error: 'Unauthorized — provide ?token=xxx' }, 401);
      }

      const phase = url.searchParams.get('phase');
      const sessionId = url.searchParams.get('session');
      const auto = url.searchParams.get('auto') === '1';

      // ── POST /sync?token=xxx&auto=1 → Start new session (Phase 1) ──
      if (!phase && request.method === 'GET') {
        try {
          const session = await createSession(env, auto);
          const result = await phase1(env, session);
          return json(result);
        } catch (e: any) {
          return json({ error: e.message }, 500);
        }
      }

      // ── Session required for phases 2-5 ──
      if (phase && !sessionId) {
        return json({ error: 'Missing ?session=xxx' }, 400);
      }

      if (phase && sessionId) {
        const session = await getSession(env, sessionId);
        if (!session) {
          return json({ error: 'Session not found or expired' }, 404);
        }

        try {
          let result: SyncSession;

          switch (phase) {
            case '2':
              result = await phase2(env, session);
              break;

            case '2.5': {
              // Manual search: ?ncmId=xxx&query=yyy
              const ncmId = parseInt(url.searchParams.get('ncmId') || '0', 10);
              const query = url.searchParams.get('query') || '';
              if (!ncmId || !query) {
                return json({ error: 'Missing ?ncmId= or ?query=' }, 400);
              }
              result = await manualSearch(env, session, ncmId, query);
              break;
            }

            case '2-skip':
              result = await skipToPhase3(env, session);
              break;

            case '3':
              result = await phase3(env, session);
              break;

            case '4':
              result = await phase4(env, session);
              break;

            case '5':
              result = await phase5(env, session);
              // Send push notification
              if (result.status === 'done') {
                const foundCount = result.amResults.filter(r => r.status === 'found').length;
                await notifySubscribers(
                  env,
                  '🎵 同步完成',
                  `${result.date}: ${foundCount}/${result.ncmTotal} 首已同步到 Apple Music`,
                  'success',
                );
              } else {
                await notifySubscribers(env, '⚠️ 同步异常', `错误: ${result.errors.join('; ')}`, 'error');
              }
              break;

            default:
              return json({ error: `Unknown phase: ${phase}` }, 400);
          }

          return json(result);
        } catch (e: any) {
          return json({ error: e.message }, 500);
        }
      }

      return json({ error: 'Invalid request' }, 400);
    }

    // ── AM search (for manual song matching) ──
    if (path === '/search') {
      if (!checkToken(url, env)) {
        return json({ error: 'Unauthorized' }, 401);
      }
      const q = url.searchParams.get('q');
      if (!q) return json({ error: 'Missing ?q=' }, 400);

      try {
        const storefront = env.STOREFRONT || 'jp';
        const developerToken = env.AM_DEVELOPER_TOKEN || '';
        const match = await searchSong(q, '', storefront, developerToken);
        return json({ match });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};
