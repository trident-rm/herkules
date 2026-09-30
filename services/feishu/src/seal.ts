import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export function createSeal(key: Buffer) {
  if (key.length !== 32) throw new Error("seal key must be 32 bytes");
  return {
    encrypt(value: unknown, purpose: string): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(purpose));
      const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
    },
    decrypt(value: string, purpose: string): unknown {
      const data = Buffer.from(value, "base64url");
      if (data.length < 29) throw new Error("invalid sealed data");
      const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      cipher.setAAD(Buffer.from(purpose));
      return JSON.parse(
        Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString(),
      );
    },
  };
}
export type Seal = ReturnType<typeof createSeal>;
