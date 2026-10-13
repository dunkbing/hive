// Encrypts secrets at rest (GitHub tokens) with AES-GCM. The key is derived from GITHUB_CLIENT_SECRET, which only
// lives in Worker secrets, so a copy of the Durable Object's storage alone cannot reveal tokens.

const encoder = new TextEncoder();

async function key(env: Env): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(env.GITHUB_CLIENT_SECRET), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("hive"), info: encoder.encode("github-token-v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function encrypt(env: Env, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), encoder.encode(plaintext));
  return `${toBase64(iv)}.${toBase64(new Uint8Array(data))}`;
}

export async function decrypt(env: Env, sealed: string): Promise<string> {
  const [iv, data] = sealed.split(".");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv) }, await key(env), fromBase64(data));
  return new TextDecoder().decode(plain);
}
