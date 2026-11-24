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
