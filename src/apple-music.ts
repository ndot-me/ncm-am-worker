import type { AmSong, Env } from './types';

const AM_API = 'https://api.music.apple.com/v1';

/**
 * Generate Apple Music developer token (JWT with ES256)
 */
export async function createDeveloperToken(
  teamId: string,
  keyId: string,
  privateKeyPem: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: keyId };
  const payload = {
    iss: teamId,
    iat: now,
    exp: now + 6 * 30 * 24 * 3600, // 6 months
  };

  const enc = new TextEncoder();
  const headerB64 = btoa(JSON.stringify(header))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const payloadB64 = btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const signingInput = `${headerB64}.${payloadB64}`;

  // Import ES256 private key from PEM
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const derBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    derBytes,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    enc.encode(signingInput),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return `${signingInput}.${sigB64}`;
}

/**
 * Apple Music API request helper
 */
async function amFetch(
  path: string,
  developerToken: string,
  userToken: string,
  options: { method?: string; body?: any } = {},
): Promise<any> {
  const resp = await fetch(`${AM_API}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${developerToken}`,
      'Music-User-Token': userToken,
      'Content-Type': 'application/json',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`AM API ${path}: ${resp.status} ${text.substring(0, 200)}`);
  }

  return resp.json();
}

/**
 * Search Apple Music catalog for a song
 * Uses iTunes Search API (no auth needed) as primary, catalog as fallback
 */
export async function searchSong(
  songName: string,
  artist: string,
  storefront: string,
  developerToken: string,
): Promise<AmSong | null> {
  const cleanName = songName
    .replace(/\s*[\(（]feat\.?[^)）]*[)）]/gi, '')
    .trim();
  const isLive = /[\(\[]live[\)\]]/i.test(songName) || /- live$/i.test(songName);

  // Build search queries
  const queries = [`${songName} ${artist}`];
  if (cleanName !== songName) queries.push(`${cleanName} ${artist}`);
  if (artist.includes('/')) {
    const firstArtist = artist.split('/')[0].trim();
    queries.push(`${songName} ${firstArtist}`);
    if (cleanName !== songName) queries.push(`${cleanName} ${firstArtist}`);
  }

  // Try catalog API first
  for (const query of queries) {
    try {
      const encoded = encodeURIComponent(query);
      const data = await amFetch(
        `/catalog/${storefront}/search?term=${encoded}&types=songs&limit=10`,
        developerToken,
        '', // no user token needed for catalog search
      );

      const songs = data.results?.songs?.data || [];
      if (songs.length > 0) {
        const scored = songs.map((s: any) => ({
          song: {
            id: s.id,
            name: s.attributes.name,
            artist: s.attributes.artistName,
            album: s.attributes.albumName,
            contentRating: s.attributes.contentRating || '',
          },
          score: scoreSong(s.attributes, songName, cleanName, artist, isLive),
        }));

        scored.sort((a: any, b: any) => b.score - a.score);
        if (scored[0].score >= 0) return scored[0].song;
      }
    } catch {
      // continue to next query
    }
  }

  // Fallback: iTunes Search API
  for (const query of queries) {
    try {
      const encoded = encodeURIComponent(query);
      const resp = await fetch(
        `https://itunes.apple.com/search?term=${encoded}&entity=song&limit=10&country=${storefront}`,
      );
      if (!resp.ok) continue;
      const data: any = await resp.json();

      const songs = data.results || [];
      if (songs.length > 0) {
        const scored = songs.map((s: any) => ({
          song: {
            id: String(s.trackId),
            name: s.trackName,
            artist: s.artistName,
            album: s.collectionName,
            contentRating: s.contentRating || '',
          },
          score: scoreSong(s, songName, cleanName, artist, isLive),
        }));

        scored.sort((a: any, b: any) => b.score - a.score);
        if (scored[0].score >= 0) return scored[0].song;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function scoreSong(
  s: any,
  songName: string,
  cleanName: string,
  artist: string,
  isLive: boolean,
): number {
  let score = 0;
  const sName = (s.name || s.trackName || '').toLowerCase();
  const sArtist = (s.artistName || s.artist || '').toLowerCase();
  const songLower = songName.toLowerCase();
  const cleanLower = cleanName.toLowerCase();
  const artistLower = artist.toLowerCase();

  // Exact name match
  if (sName === songLower || sName === cleanLower) score += 10;
  // Partial name match
  else if (sName.includes(cleanLower) || cleanLower.includes(sName)) score += 5;

  // Artist match
  if (sArtist === artistLower) score += 8;
  else if (
    artist
      .split('/')
      .some((a) => sArtist.includes(a.trim().toLowerCase()))
  )
    score += 4;

  // Penalize Live if original is not Live
  const sIsLive = /[\(\[]live[\)\]]/i.test(sName) || /- live/i.test(sName);
  if (!isLive && sIsLive) score -= 15;
  if (isLive && sIsLive) score += 2;

  // Prefer explicit
  if (s.contentRating === 'explicit') score += 3;

  return score;
}

/**
 * List library playlists
 */
export async function listPlaylists(
  developerToken: string,
  userToken: string,
): Promise<{ id: string; name: string }[]> {
  const data = await amFetch('/me/library/playlists', developerToken, userToken);
  return (data.data || []).map((p: any) => ({
    id: p.id,
    name: p.attributes.name,
  }));
}

/**
 * Create a new playlist in the user's library
 */
export async function createPlaylist(
  name: string,
  developerToken: string,
  userToken: string,
): Promise<string> {
  const data = await amFetch('/me/library/playlists', developerToken, userToken, {
    method: 'POST',
    body: { attributes: { name } },
  });
  return data.data.id;
}

/**
 * Add songs to a playlist
 */
export async function addSongsToPlaylist(
  playlistId: string,
  songIds: string[],
  developerToken: string,
  userToken: string,
): Promise<void> {
  // Apple Music API limits ~100 songs per request
  const BATCH = 50;
  for (let i = 0; i < songIds.length; i += BATCH) {
    const batch = songIds.slice(i, i + BATCH);
    await amFetch(
      `/me/library/playlists/${playlistId}/tracks`,
      developerToken,
      userToken,
      {
        method: 'POST',
        body: {
          data: batch.map((id) => ({ id, type: 'songs' })),
        },
      },
    );
  }
}

/**
 * Delete a playlist
 */
export async function deletePlaylist(
  playlistId: string,
  developerToken: string,
  userToken: string,
): Promise<void> {
  await fetch(`${AM_API}/me/library/playlists/${playlistId}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${developerToken}`,
      'Music-User-Token': userToken,
    },
  });
  // Don't throw on 404 — playlist may already be gone
}
