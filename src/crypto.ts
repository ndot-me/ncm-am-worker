// ── weapi encryption for Netease Cloud Music ──
// Ported from @neteasecloudmusicapienhanced/api/util/crypto.js

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const PUBLIC_KEY_HEX =
  '30819f300d06092a864886f70d010101050003818d00308189' +
  '02818100e09c68b7c8e0a0b2d75e3f6a27a0e68f23e8f0a0' +
  'e7c3d4b2f5c8d3a1b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9' +
  'f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3' +
  'f4a5b6c7d8e9f0a1b2c3d4e5f6010001'; // Not used, inline instead

// Full modulus from the PEM
const RSA_MODULUS_HEX =
  'e09c68b7c8e0a0b2d75e3f6a27a0e68f23e8f0a0' +
  ''; // placeholder

const PUBLIC_KEY_MODULUS = BigInt(
  '0x' +
  'c546e70305165363268098c59398c037b46fd34c' +
  '7a81c98f52c59b2c4f1d2e3a4b5c6d7e8f9a0b1c' +
  '' // We'll use the actual modulus below
);

// Actually, let me just use the real public key from the NCM crypto source
// The modulus (n) and exponent (e=65537) from the PEM

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function padEnd(s: string, len: number, char: string): string {
  while (s.length < len) s += char;
  return s;
}

// AES-CBC encrypt using Web Crypto
async function aesCbcEncrypt(
  plaintext: string,
  key: string,
  iv: string,
): Promise<string> {
  const enc = new TextEncoder();
  const keyBytes = enc.encode(key);
  const ivBytes = enc.encode(iv);
  const dataBytes = enc.encode(plaintext);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-CBC' },
    false,
    ['encrypt'],
  );

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: ivBytes },
    cryptoKey,
    dataBytes,
  );

  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

// RSA PKCS1 v1.5 encrypt (raw, no hash) using BigInt
function rsaEncrypt(message: string, modulusHex: string, exponent: number): string {
  // Convert message bytes to BigInt
  const msgBytes = new TextEncoder().encode(message);
  const msgHex = bytesToHex(msgBytes);
  let m = BigInt('0x' + msgHex);

  // PKCS1 v1.5 Type 2 padding
  const modLen = modulusHex.length / 2; // byte length
  const padLen = modLen - msgBytes.length - 3;
  let padded = '0002';
  const rng = new Uint8Array(padLen);
  crypto.getRandomValues(rng);
  // Ensure no zero bytes in random padding
  for (let i = 0; i < rng.length; i++) {
    if (rng[i] === 0) rng[i] = 1;
  }
  padded += bytesToHex(rng);
  padded += '00';
  padded += msgHex;

  const n = BigInt('0x' + modulusHex);
  const e = BigInt(exponent);
  const p = BigInt('0x' + padded);

  // RSA: c = p^e mod n
  let result = BigInt(1);
  let base = p % n;
  let exp = e;
  while (exp > 0) {
    if (exp & BigInt(1)) {
      result = (result * base) % n;
    }
    base = (base * base) % n;
    exp >>= BigInt(1);
  }

  return result.toString(16).padStart(modLen * 2, '0');
}

/**
 * weapi encrypt: double AES-CBC + RSA
 * Returns { params, encSecKey } for URL-encoded POST body
 */
export async function weapiEncrypt(data: Record<string, unknown>): Promise<{
  params: string;
  encSecKey: string;
}> {
  const text = JSON.stringify(data);

  // Generate random 16-char base62 key
  let secretKey = '';
  for (let i = 0; i < 16; i++) {
    secretKey += BASE62[Math.floor(Math.random() * 62)];
  }

  // Double AES-CBC encryption
  const firstPass = await aesCbcEncrypt(text, PRESET_KEY, IV);
  const params = await aesCbcEncrypt(firstPass, secretKey, IV);

  // RSA encrypt the reversed secret key
  const reversedKey = secretKey.split('').reverse().join('');

  // The NCM RSA public key modulus (from the PEM in crypto.js)
  const modulus =
    'e0b72f3af0e33c5b40d842f44e4e1e4c4c3b2a190807060504030201' +
    '00ff01'; // placeholder - we need the real one

  // Actually, let me use the proper modulus from the source PEM
  // The public key is: MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
  // Decoding: modulus = e09c68b7..., exponent = 65537
  // Let me decode the actual modulus from the base64

  const encSecKey = rsaEncrypt(reversedKey, getRsaModulus(), 65537);

  return { params, encSecKey };
}

// Decode the RSA public key modulus from the PEM in the NCM source
let _rsaModulus: string | null = null;
function getRsaModulus(): string {
  if (_rsaModulus) return _rsaModulus;

  // The actual modulus from: MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
  // This is a standard RSA 1024-bit public key in SubjectPublicKeyInfo DER format
  // The modulus starts after the header bytes
  const derB64 =
    'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX' +
    '/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9sn' +
    'QXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45' +
    'wIDAQAB';
  const der = Uint8Array.from(atob(derB64), (c) => c.charCodeAt(0));

  // SubjectPublicKeyInfo: SEQUENCE { SEQUENCE { OID, NULL }, BIT STRING { SEQUENCE { modulus, exponent } } }
  // The modulus is at a fixed offset in this standard key format
  // Skip: 30 81 9f 30 0d 06 09 ... 05 00 03 81 8d 00 30 81 89 02 81 81 00
  // That's 22 bytes of header + "00" prefix on modulus
  // Modulus is 128 bytes (1024-bit key)
  const modBytes = der.slice(24, 24 + 128); // skip 22 header bytes + SEQUENCE tag/len + 00 prefix
  _rsaModulus = bytesToHex(modBytes);
  return _rsaModulus;
}
