import type { Env } from './types';
import { sync, formatResult } from './sync';
import {
  checkLogin,
  refreshLoginRaw,
  qrLoginCreateKey,
  qrLoginUrl,
  qrLoginCheck,
} from './ncm';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: corsHeaders });
}

export default {
  // ── Cron trigger ──
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[${new Date().toISOString()}] NCM→AM sync triggered by cron`);
    const result = await sync(env);
    const text = formatResult(result);
    console.log(text);

    // Save result to KV
    await env.STATE.put('last_sync', JSON.stringify(result), {
      expirationTtl: 86400 * 4,
    });
    await env.STATE.put('last_sync_text', text, {
      expirationTtl: 86400 * 4,
    });
  },

  // ── HTTP handler ──
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── GET / ──
    if (path === '/' && request.method === 'GET') {
      return json({
        service: 'ncm-am-worker',
        endpoints: {
          'GET  /status':      'NCM 登录状态 + 最近同步结果',
          'POST /sync':        '手动触发同步',
          'GET  /login':       '获取 QR 登录 URL',
          'GET  /login/check': '轮询 QR 扫码状态 (query: key=xxx)',
        },
      });
    }

    // ── GET /status ──
    if (path === '/status' && request.method === 'GET') {
      // Check NCM login
      let cookie = env.NCM_COOKIE;
      let savedCookie = await env.STATE.get('ncm_cookie');
      if (savedCookie) cookie = savedCookie;

      let ncmStatus: { ok: boolean; uid?: string; nickname?: string; error?: string };
      try {
        ncmStatus = await checkLogin(cookie);
      } catch (e: any) {
        ncmStatus = { ok: false, error: e.message };
      }

      // Try refresh if not ok
      let refreshed = false;
      if (!ncmStatus.ok) {
        const newCookie = await refreshLoginRaw(cookie);
        if (newCookie) {
          const recheck = await checkLogin(newCookie);
          if (recheck.ok) {
            await env.STATE.put('ncm_cookie', newCookie, { expirationTtl: 86400 * 60 });
            ncmStatus = recheck;
            refreshed = true;
          }
        }
      }

      const lastSync = await env.STATE.get('last_sync_text');

      return json({
        ncm: {
          ...ncmStatus,
          refreshed,
          message: ncmStatus.ok
            ? `✅ 登录正常 (${ncmStatus.nickname || ncmStatus.uid})`
            : `❌ 登录已过期，请访问 /login 重新扫码`,
        },
        lastSync: lastSync || null,
      });
    }

    // ── GET /login ──
    // Start QR login flow: generate key, return QR URL
    if (path === '/login' && request.method === 'GET') {
      try {
        const key = await qrLoginCreateKey();
        const url = qrLoginUrl(key);

        // Save key to KV for polling
        await env.STATE.put(`qr_key:${key}`, 'pending', { expirationTtl: 300 });

        return json({
          ok: true,
          key,
          qrUrl: url,
          instructions: [
            '1. 用网易云音乐 App 扫描 qrUrl 中的二维码',
            '2. 在 App 中确认登录',
            `3. 访问 GET /login/check?key=${key} 查看状态`,
            '4. 状态变为 803 表示成功，cookie 自动保存',
          ],
        });
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── GET /login/check?key=xxx ──
    // Poll QR login status
    if (path === '/login/check' && request.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!key) {
        return json({ error: 'Missing ?key= parameter' }, 400);
      }

      try {
        const result = await qrLoginCheck(key);

        // 803 = success
        if (result.code === 803 && result.cookie) {
          // Save new cookie
          await env.STATE.put('ncm_cookie', result.cookie, { expirationTtl: 86400 * 60 });
          // Clean up QR key
          await env.STATE.delete(`qr_key:${key}`);

          // Verify the new cookie works
          const status = await checkLogin(result.cookie);

          return json({
            code: 803,
            status: 'success',
            message: '✅ 登录成功，cookie 已保存',
            user: status.ok ? { uid: status.uid, nickname: status.nickname } : null,
          });
        }

        // Map status codes
        const statusMap: Record<number, string> = {
          800: '❌ 二维码已过期，请重新访问 /login',
          801: '⏳ 等待扫码...',
          802: '⏳ 已扫码，等待确认...',
        };

        return json({
          code: result.code,
          status: statusMap[result.code] || `未知状态: ${result.code}`,
          message: result.message,
        });
      } catch (e: any) {
        return json({ ok: false, error: e.message }, 500);
      }
    }

    // ── POST /sync ──
    if (path === '/sync' && request.method === 'POST') {
      try {
        const result = await sync(env);
        const text = formatResult(result);
        await env.STATE.put('last_sync', JSON.stringify(result), { expirationTtl: 86400 * 4 });
        await env.STATE.put('last_sync_text', text, { expirationTtl: 86400 * 4 });
        return json(result);
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};
