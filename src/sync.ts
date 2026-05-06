import { getDailySongs, songArtist, AuthError, refreshLoginRaw, checkLogin } from './ncm';
import {
  createDeveloperToken,
  searchSong,
  listPlaylists,
  createPlaylist,
  addSongsToPlaylist,
  deletePlaylist,
} from './apple-music';
import type { Env, SyncResult } from './types';

const PLAYLIST_PREFIX_DEFAULT = 'NCM Daily ';
const KEEP_DAYS_DEFAULT = 3;

/**
 * Get valid NCM cookie — check login, refresh if needed, save to KV.
 */
async function getValidCookie(env: Env): Promise<string> {
  let cookie = env.NCM_COOKIE;

  // 1. Check current cookie
  const status = await checkLogin(cookie);
  if (status.ok) return cookie;

  // 2. Cookie expired — try refresh
  console.log('[NCM] Cookie expired, attempting refresh...');
  const newCookie = await refreshLoginRaw(cookie);
  if (newCookie) {
    const recheck = await checkLogin(newCookie);
    if (recheck.ok) {
      console.log('[NCM] Refresh successful');
      // Save new cookie to KV for next run
      await env.KV.put('ncm_cookie', newCookie, { expirationTtl: 86400 * 60 });
      return newCookie;
    }
  }

  // 3. Refresh failed — check if we have a saved cookie in KV
  const saved = await env.KV.get('ncm_cookie');
  if (saved) {
    const savedStatus = await checkLogin(saved);
    if (savedStatus.ok) {
      console.log('[NCM] Using saved cookie from KV');
      return saved;
    }
  }

  // 4. All failed — throw
  throw new Error(
    'NCM cookie expired and refresh failed. ' +
    'Please re-login via QR code and update the NCM_COOKIE secret.'
  );
}

/**
 * Main sync: NCM daily songs → Apple Music playlist
 */
export async function sync(env: Env): Promise<SyncResult> {
  const prefix = env.PLAYLIST_PREFIX || PLAYLIST_PREFIX_DEFAULT;
  const keepDays = parseInt(env.KEEP_DAYS || String(KEEP_DAYS_DEFAULT), 10);
  const storefront = env.STOREFRONT || 'cn';

  // Time in UTC+8
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const dateStr = now.toISOString().slice(0, 10);
  const playlistName = `${prefix}${dateStr}`;

  const result: SyncResult = {
    date: dateStr,
    total: 0,
    found: 0,
    notFound: [],
    playlistId: null,
    deletedPlaylists: [],
    errors: [],
  };

  // 1. Get Apple Music developer token (use existing or generate)
  let developerToken: string;
  if (env.AM_DEVELOPER_TOKEN) {
    developerToken = env.AM_DEVELOPER_TOKEN;
  } else {
    try {
      developerToken = await createDeveloperToken(
        env.AM_TEAM_ID,
        env.AM_KEY_ID,
        env.AM_PRIVATE_KEY,
      );
    } catch (e: any) {
      result.errors.push(`Failed to create developer token: ${e.message}`);
      return result;
    }
  }

  // 2. Get valid NCM cookie (auto-refresh if expired)
  let cookie: string;
  try {
    cookie = await getValidCookie(env);
  } catch (e: any) {
    result.errors.push(`NCM auth failed: ${e.message}`);
    return result;
  }

  // 3. Fetch NCM daily songs
  let songs: Awaited<ReturnType<typeof getDailySongs>>['songs'];
  try {
    const r = await getDailySongs(cookie);
    songs = r.songs;
  } catch (e: any) {
    if (e instanceof AuthError) {
      // One more attempt: force refresh and retry
      console.log('[NCM] Auth error on fetch, retrying after refresh...');
      const newCookie = await refreshLoginRaw(cookie);
      if (newCookie) {
        await env.KV.put('ncm_cookie', newCookie, { expirationTtl: 86400 * 60 });
        const r = await getDailySongs(newCookie);
        songs = r.songs;
      } else {
        result.errors.push(`NCM auth expired and refresh failed`);
        return result;
      }
    } else {
      result.errors.push(`NCM fetch failed: ${e.message}`);
      return result;
    }
  }

  result.total = songs.length;
  if (songs.length === 0) {
    result.errors.push('No daily songs from NCM');
    return result;
  }

  // 4. Search each song on Apple Music
  const foundIds: string[] = [];
  for (const song of songs) {
    const artist = songArtist(song);
    try {
      const match = await searchSong(song.name, artist, storefront, developerToken);
      if (match) {
        foundIds.push(match.id);
        result.found++;
      } else {
        result.notFound.push(`${song.name} — ${artist}`);
      }
    } catch (e: any) {
      result.notFound.push(`${song.name} — ${artist} (error: ${e.message})`);
    }
  }

  // 5. Check if playlist already exists
  let existingPlaylists: { id: string; name: string }[];
  try {
    existingPlaylists = await listPlaylists(developerToken, env.AM_USER_TOKEN);
  } catch (e: any) {
    result.errors.push(`List playlists failed: ${e.message}`);
    return result;
  }

  const existing = existingPlaylists.find((p) => p.name === playlistName);

  // 6. Create or update playlist
  if (foundIds.length > 0) {
    try {
      if (existing) {
        await addSongsToPlaylist(existing.id, foundIds, developerToken, env.AM_USER_TOKEN);
        result.playlistId = existing.id;
      } else {
        const plId = await createPlaylist(playlistName, developerToken, env.AM_USER_TOKEN);
        await addSongsToPlaylist(plId, foundIds, developerToken, env.AM_USER_TOKEN);
        result.playlistId = plId;
      }
    } catch (e: any) {
      result.errors.push(`Playlist operation failed: ${e.message}`);
    }
  }

  // 7. Clean up old playlists
  const cutoffDate = new Date(now.getTime() - (keepDays - 1) * 86400000);
  const cutoffStr = cutoffDate.toISOString().slice(0, 10);

  for (const pl of existingPlaylists) {
    if (!pl.name.startsWith(prefix)) continue;
    const plDate = pl.name.slice(prefix.length);
    if (/^\d{4}-\d{2}-\d{2}$/.test(plDate) && plDate < cutoffStr) {
      try {
        await deletePlaylist(pl.id, developerToken, env.AM_USER_TOKEN);
        result.deletedPlaylists.push(pl.name);
      } catch (e: any) {
        result.errors.push(`Delete ${pl.name} failed: ${e.message}`);
      }
    }
  }

  return result;
}

/**
 * Format sync result as human-readable text
 */
export function formatResult(r: SyncResult): string {
  const lines = [
    `🎵 网易云 → Apple Music 每日同步`,
    `📅 ${r.date}`,
    `✅ 已同步: ${r.found}/${r.total} 首`,
  ];

  if (r.playlistId) {
    lines.push(`📋 歌单 ID: ${r.playlistId}`);
  }

  if (r.notFound.length > 0) {
    lines.push(`\n❌ 未找到 (${r.notFound.length} 首):`);
    for (const s of r.notFound) lines.push(`   • ${s}`);
  }

  if (r.deletedPlaylists.length > 0) {
    lines.push(`\n🗑️ 已清理: ${r.deletedPlaylists.join(', ')}`);
  }

  if (r.errors.length > 0) {
    lines.push(`\n⚠️ 错误:`);
    for (const e of r.errors) lines.push(`   • ${e}`);
  }

  return lines.join('\n');
}
