export interface Env {
  // KV (single namespace)
  KV: KVNamespace;

  // Secrets (set via wrangler secret)
  NCM_COOKIE: string;             // MUSIC_U=xxx; __csrf=yyy (initial, auto-refreshed)
  AM_DEVELOPER_TOKEN?: string;    // Apple Music JWT (if pre-existing)
  AM_USER_TOKEN: string;          // media-user-token from cookie
  AM_TEAM_ID?: string;            // Apple Developer Team ID (if generating token)
  AM_KEY_ID?: string;             // MusicKit Key ID (if generating token)
  AM_PRIVATE_KEY?: string;        // MusicKit private key PEM (if generating token)
  SYNC_TOKEN: string;             // Bearer token for sync API auth

  // Optional
  PLAYLIST_PREFIX?: string;       // default "NCM Daily "
  KEEP_DAYS?: string;             // default "3"
  STOREFRONT?: string;            // default "jp"
}

export interface NcmSong {
  id: number;
  name: string;
  artists: { id: number; name: string }[];
  album: { id: number; name: string };
  cover: string;
}

export interface AmSong {
  id: string;
  name: string;
  artist: string;
  album?: string;
  contentRating?: string;
}

export interface SyncResult {
  date: string;
  total: number;
  found: number;
  notFound: string[];
  playlistId: string | null;
  deletedPlaylists: string[];
  errors: string[];
}

// ── Extended types for multi-phase sync ──

export interface NcmSongDisplay {
  id: number;
  name: string;
  artist: string;
  album: string;
  cover: string;       // album art URL
  ncmUrl: string;      // link to NCM song page
}

export interface AmSearchResult {
  ncmId: number;
  ncmName: string;
  ncmArtist: string;
  amId: string | null;
  amName: string | null;
  amArtist: string | null;
  amAlbum: string | null;
  status: 'found' | 'not_found' | 'error';
  error?: string;
}

export interface SyncSession {
  id: string;
  phase: number;               // current phase (1-5)
  status: 'running' | 'done' | 'error';
  auto: boolean;               // auto-skip missing songs
  createdAt: number;

  // Phase 1 output
  ncmSongs: NcmSongDisplay[];
  ncmTotal: number;
  date: string;

  // Phase 2 output
  amResults: AmSearchResult[];
  amBatchIndex: number;        // which batch we're on
  amBatchSize: number;         // songs per batch
  storefront: string;

  // Phase 3 output
  playlistId: string | null;
  playlistName: string;

  // Phase 4 output
  addedCount: number;

  // Phase 5 output
  deletedPlaylists: string[];

  // Final
  errors: string[];
}
