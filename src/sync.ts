import { getDailySongs, songArtist, AuthError, refreshLoginRaw, checkLogin } from './ncm';
import {
  createDeveloperToken,
  searchSong,
  listPlaylists,
  createPlaylist,
  addSongsToPlaylist,
  deletePlaylist,
} from './apple-music';
import type { Env, NcmSong, NcmSongDisplay, AmSearchResult, SyncSession } from './types';

const PLAYLIST_PREFIX_DEFAULT = 'NCM Daily ';
const KEEP_DAYS_DEFAULT = 3;
const STOREFRONT_DEFAULT = 'jp';
const SESSION_TTL = 3600;          // 1 hour
const BATCH_SIZE = 20;             // songs per Phase 2 batch

// ── Session management ──

function newSessionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function emptySession(id: string, auto: boolean): SyncSession {
  return {
    id,
    phase: 1,
    status: 'running',
    auto,
    createdAt: Date.now(),
    ncmSongs: [],
    ncmTotal: 0,
    date: '',
    amResults: [],
    amBatchIndex: 0,
    amBatchSize: BATCH_SIZE,
    storefront: '',
    playlistId: null,
    playlistName: '',
    addedCount: 0,
    deletedPlaylists: [],
    errors: [],
  };
}

export async function createSession(env: Env, auto: boolean): Promise<SyncSession> {
  // Clear any existing active session
  const oldId = await env.KV.get('active_session');
  if (oldId) {
    await env.KV.delete(`session:${oldId}`);
  }

  const id = newSessionId();
  const session = emptySession(id, auto);
  await saveSession(env, session);
  await env.KV.put('active_session', id, { expirationTtl: SESSION_TTL });
  return session;
}

export async function getSession(env: Env, id: string): Promise<SyncSession | null> {
  const raw = await env.KV.get(`session:${id}`, 'json');
  return raw as SyncSession | null;
}

export async function saveSession(env: Env, session: SyncSession): Promise<void> {
  await env.KV.put(`session:${session.id}`, JSON.stringify(session), { expirationTtl: SESSION_TTL });
}

// ── NCM cookie helper ──

async function getValidCookie(env: Env): Promise<string> {
  let cookie = env.NCM_COOKIE;
  const status = await checkLogin(cookie);
  if (status.ok) return cookie;

  console.log('[NCM] Cookie expired, attempting refresh...');
  const newCookie = await refreshLoginRaw(cookie);
  if (newCookie) {
    const recheck = await checkLogin(newCookie);
    if (recheck.ok) {
      console.log('[NCM] Refresh successful');
      await env.KV.put('ncm_cookie', newCookie, { expirationTtl: 86400 * 60 });
      return newCookie;
    }
  }

  const saved = await env.KV.get('ncm_cookie');
  if (saved) {
    const savedStatus = await checkLogin(saved);
    if (savedStatus.ok) {
      console.log('[NCM] Using saved cookie from KV');
      return saved;
    }
  }

  throw new Error('NCM cookie expired and refresh failed. Please re-login via /login');
}

// ── Developer token helper ──

async function getDeveloperToken(env: Env): Promise<string> {
  if (env.AM_DEVELOPER_TOKEN) return env.AM_DEVELOPER_TOKEN;
  return createDeveloperToken(env.AM_TEAM_ID!, env.AM_KEY_ID!, env.AM_PRIVATE_KEY!);
}

// ── Phase 1: Fetch NCM daily songs ──

export async function phase1(env: Env, session: SyncSession): Promise<SyncSession> {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  session.date = now.toISOString().slice(0, 10);

  try {
    const cookie = await getValidCookie(env);

    let songs: NcmSong[];
    try {
      const r = await getDailySongs(cookie);
      songs = r.songs;
    } catch (e: any) {
      if (e instanceof AuthError) {
        const newCookie = await refreshLoginRaw(cookie);
        if (newCookie) {
          await env.KV.put('ncm_cookie', newCookie, { expirationTtl: 86400 * 60 });
          const r = await getDailySongs(newCookie);
          songs = r.songs;
        } else {
          throw new Error('NCM auth expired and refresh failed');
        }
      } else {
        throw e;
      }
    }

    session.ncmTotal = songs.length;
    session.ncmSongs = songs.map((s: NcmSong) => ({
      id: s.id,
      name: s.name,
      artist: s.artists.map(a => a.name).join(' / '),
      album: s.album.name,
      cover: s.cover || '',
      ncmUrl: `https://music.163.com/song?id=${s.id}`,
    }));

    session.phase = 2;
    session.status = 'running';
  } catch (e: any) {
    session.status = 'error';
    session.errors.push(`Phase 1 failed: ${e.message}`);
  }

  await saveSession(env, session);
  return session;
}

// ── Phase 2: Search Apple Music (batched) ──

export async function phase2(env: Env, session: SyncSession): Promise<SyncSession> {
  const storefront = env.STOREFRONT || STOREFRONT_DEFAULT;
  session.storefront = storefront;

  try {
    const developerToken = await getDeveloperToken(env);

    // Initialize results array if first batch
    if (session.amResults.length === 0) {
      session.amResults = session.ncmSongs.map(s => ({
        ncmId: s.id,
        ncmName: s.name,
        ncmArtist: s.artist,
        amId: null,
        amName: null,
        amArtist: null,
        amAlbum: null,
        status: 'not_found' as const,
      }));
      session.amBatchIndex = 0;
    }

    const start = session.amBatchIndex * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, session.ncmSongs.length);
    const batch = session.ncmSongs.slice(start, end);

    for (let i = 0; i < batch.length; i++) {
      const song = batch[i];
      const resultIdx = start + i;

      try {
        const match = await searchSong(song.name, song.artist, storefront, developerToken);
        if (match) {
          session.amResults[resultIdx] = {
            ncmId: song.id,
            ncmName: song.name,
            ncmArtist: song.artist,
            amId: match.id,
            amName: match.name,
            amArtist: match.artist,
            amAlbum: match.album || null,
            status: 'found',
          };
        } else {
          session.amResults[resultIdx].status = 'not_found';
        }
      } catch (e: any) {
        session.amResults[resultIdx] = {
          ...session.amResults[resultIdx],
          status: 'error',
          error: e.message,
        };
      }
    }

    session.amBatchIndex++;

    // Check if more batches needed
    const totalBatches = Math.ceil(session.ncmSongs.length / BATCH_SIZE);
    if (session.amBatchIndex >= totalBatches) {
      // All batches done
      const foundCount = session.amResults.filter(r => r.status === 'found').length;
      const notFoundCount = session.amResults.filter(r => r.status !== 'found').length;

      if (session.auto || notFoundCount === 0) {
        // Auto-skip or all found → go to phase 3
        session.phase = 3;
      } else {
        // Wait for user to review / manually search
        session.phase = 2.5; // intermediate: waiting for user
      }
    }
    // else: more batches remain, stay at phase 2

    session.status = 'running';
  } catch (e: any) {
    session.status = 'error';
    session.errors.push(`Phase 2 failed: ${e.message}`);
  }

  await saveSession(env, session);
  return session;
}

// ── Phase 2.5: Manual search for a single song ──

export async function manualSearch(
  env: Env,
  session: SyncSession,
  ncmId: number,
  query: string,
): Promise<SyncSession> {
  const storefront = env.STOREFRONT || STOREFRONT_DEFAULT;
  const developerToken = await getDeveloperToken(env);

  // Search AM with the user-provided query
  // query format: "song name artist" or just "song name"
  const parts = query.split(' ');
  const songName = parts.slice(0, -1).join(' ') || query;
  const artist = parts.length > 1 ? parts[parts.length - 1] : '';

  try {
    const match = await searchSong(songName, artist || query, storefront, developerToken);
    const idx = session.amResults.findIndex(r => r.ncmId === ncmId);
    if (idx >= 0 && match) {
      session.amResults[idx] = {
        ...session.amResults[idx],
        amId: match.id,
        amName: match.name,
        amArtist: match.artist,
        amAlbum: match.album || null,
        status: 'found',
      };
    }
  } catch (e: any) {
    // search failed, leave as not_found
  }

  await saveSession(env, session);
  return session;
}

// ── Phase 2 → 3: Skip remaining and proceed ──

export async function skipToPhase3(env: Env, session: SyncSession): Promise<SyncSession> {
  session.phase = 3;
  session.status = 'running';
  await saveSession(env, session);
  return session;
}

// ── Phase 3: Create playlist ──

export async function phase3(env: Env, session: SyncSession): Promise<SyncSession> {
  const prefix = env.PLAYLIST_PREFIX || PLAYLIST_PREFIX_DEFAULT;
  session.playlistName = `${prefix}${session.date}`;

  try {
    const developerToken = await getDeveloperToken(env);

    // Check if playlist already exists
    const playlists = await listPlaylists(developerToken, env.AM_USER_TOKEN);
    const existing = playlists.find(p => p.name === session.playlistName);

    if (existing) {
      session.playlistId = existing.id;
    } else {
      const plId = await createPlaylist(session.playlistName, developerToken, env.AM_USER_TOKEN);
      session.playlistId = plId;
    }

    session.phase = 4;
    session.status = 'running';
  } catch (e: any) {
    session.status = 'error';
    session.errors.push(`Phase 3 failed: ${e.message}`);
  }

  await saveSession(env, session);
  return session;
}

// ── Phase 4: Add songs to playlist ──

export async function phase4(env: Env, session: SyncSession): Promise<SyncSession> {
  if (!session.playlistId) {
    session.status = 'error';
    session.errors.push('No playlist ID — run Phase 3 first');
    await saveSession(env, session);
    return session;
  }

  try {
    const developerToken = await getDeveloperToken(env);
    const foundIds = session.amResults
      .filter(r => r.status === 'found' && r.amId)
      .map(r => r.amId!);

    if (foundIds.length > 0) {
      await addSongsToPlaylist(session.playlistId, foundIds, developerToken, env.AM_USER_TOKEN);
      session.addedCount = foundIds.length;
    }

    session.phase = 5;
    session.status = 'running';
  } catch (e: any) {
    session.status = 'error';
    session.errors.push(`Phase 4 failed: ${e.message}`);
  }

  await saveSession(env, session);
  return session;
}

// ── Phase 5: Delete old playlists ──

export async function phase5(env: Env, session: SyncSession): Promise<SyncSession> {
  const prefix = env.PLAYLIST_PREFIX || PLAYLIST_PREFIX_DEFAULT;
  const keepDays = parseInt(env.KEEP_DAYS || String(KEEP_DAYS_DEFAULT), 10);

  try {
    const developerToken = await getDeveloperToken(env);
    const playlists = await listPlaylists(developerToken, env.AM_USER_TOKEN);

    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const cutoffDate = new Date(now.getTime() - (keepDays - 1) * 86400000);
    const cutoffStr = cutoffDate.toISOString().slice(0, 10);

    for (const pl of playlists) {
      if (!pl.name.startsWith(prefix)) continue;
      const plDate = pl.name.slice(prefix.length);
      if (/^\d{4}-\d{2}-\d{2}$/.test(plDate) && plDate < cutoffStr) {
        try {
          await deletePlaylist(pl.id, developerToken, env.AM_USER_TOKEN);
          session.deletedPlaylists.push(pl.name);
        } catch (e: any) {
          session.errors.push(`Delete ${pl.name} failed: ${e.message}`);
        }
      }
    }

    session.status = 'done';
    session.phase = 5;
  } catch (e: any) {
    session.status = 'error';
    session.errors.push(`Phase 5 failed: ${e.message}`);
  }

  await saveSession(env, session);
  return session;
}
