export function makeSalt() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashPasscode(passcode, salt) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(passcode), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: 120000,
    },
    key,
    256
  );
  return Array.from(new Uint8Array(bits), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function legacyHashPasscode(passcode, salt) {
  const data = new TextEncoder().encode(`${salt}:${passcode}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createAuth(passcode) {
  const pinSalt = makeSalt();
  const pinHash = await hashPasscode(passcode, pinSalt);
  return { pinSalt, pinHash, pinKdf: "PBKDF2-SHA256", pinIterations: 120000 };
}

export async function verifyPasscode(user, passcode) {
  if (user.pinHash && user.pinSalt) {
    if (!user.pinKdf) return (await legacyHashPasscode(passcode, user.pinSalt)) === user.pinHash;
    return (await hashPasscode(passcode, user.pinSalt)) === user.pinHash;
  }
  return user.pin === passcode;
}
