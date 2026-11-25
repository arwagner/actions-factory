import sodium from "libsodium-wrappers";

/** A public key for sealed boxes: base64, as GitHub hands it out. */
export type Seal = (plaintext: string, publicKeyBase64: string) => Promise<string>;

/** Encrypts to a public key with a libsodium sealed box, the scheme GitHub secrets use. Returns base64. */
export const sealBox: Seal = async (plaintext, publicKeyBase64) => {
  await sodium.ready;
  const key = sodium.from_base64(publicKeyBase64, sodium.base64_variants.ORIGINAL);
  return sodium.to_base64(sodium.crypto_box_seal(plaintext, key), sodium.base64_variants.ORIGINAL);
};

/** Makes the transport key pair (X25519), both halves base64. */
export async function transportKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
    privateKey: sodium.to_base64(pair.privateKey, sodium.base64_variants.ORIGINAL),
  };
}

/** Opens a sealed box with the transport private key (base64); the public half is derived from it. Throws if it doesn't open. */
export async function openBox(sealedBase64: string, privateKeyBase64: string): Promise<string> {
  await sodium.ready;
  const secret = sodium.from_base64(privateKeyBase64, sodium.base64_variants.ORIGINAL);
  const publicKey = sodium.crypto_scalarmult_base(secret);
  const opened = sodium.crypto_box_seal_open(sodium.from_base64(sealedBase64, sodium.base64_variants.ORIGINAL), publicKey, secret);
  return sodium.to_string(opened);
}
