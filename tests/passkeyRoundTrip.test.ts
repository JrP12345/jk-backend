import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Passkey } from "../models/Passkey.ts";
import { createRefreshTokenDetails, generateAccessToken } from "../utilities/helpers.ts";

const cookies = (response: any) => response.cookies.map((cookie: any) => `${cookie.name}=${cookie.value}`).join("; ");
const digest = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest();
const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");

describe("Passkey cryptographic round trip", () => {
  it("enrolls and signs in with a signed credential, rejects another origin, and preserves existing 2FA", async () => {
    process.env.WEBAUTHN_ORIGIN = "http://localhost:3000";
    process.env.WEBAUTHN_RP_ID = "localhost";
    const user = await User.create({ name: "Passkey Patient", email: "passkey-roundtrip@test.com", role: "patient" });
    const { rawToken, sessionId } = await createRefreshTokenDetails(user.id);
    const access = generateAccessToken({ id: user.id, email: user.email!, role: "patient", sessionId });
    const accountCookie = `access_token=${access}; refresh_token=${rawToken}`;
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const credentialId = crypto.randomBytes(32);
    const coseKey = isoCBOR.encode(new Map<number, any>([
      [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")],
    ]) as any);
    const register = await app.inject({ method: "POST", url: "/api/auth/passkeys/register/options", headers: { cookie: accountCookie } });
    expect(register.statusCode, register.body).toBe(200);
    const clientDataJSON = b64(Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: register.json().data.challenge, origin: "http://localhost:3000", crossOrigin: false })));
    const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length);
    const authData = Buffer.concat([digest("localhost"), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), length, credentialId, Buffer.from(coseKey)]);
    const attestationObject = b64(isoCBOR.encode(new Map<string, any>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]])));
    const enrolled = await app.inject({ method: "POST", url: "/api/auth/passkeys/register/verify", headers: { cookie: `${accountCookie}; ${cookies(register)}` }, payload: { name: "Test device", response: { id: b64(credentialId), rawId: b64(credentialId), type: "public-key", response: { clientDataJSON, attestationObject, transports: ["internal"] }, clientExtensionResults: {} } } });
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    expect(await Passkey.countDocuments({ userId: user._id })).toBe(1);

    const signIn = async (counter: number, origin = "http://localhost:3000") => {
      const options = await app.inject({ method: "POST", url: "/api/auth/passkeys/login/options" });
      expect(options.statusCode).toBe(200);
      const client = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.json().data.challenge, origin, crossOrigin: false }));
      const count = Buffer.alloc(4); count.writeUInt32BE(counter);
      const authenticator = Buffer.concat([digest("localhost"), Buffer.from([0x05]), count]);
      const signature = crypto.sign("sha256", Buffer.concat([authenticator, digest(client)]), privateKey);
      return app.inject({ method: "POST", url: "/api/auth/passkeys/login/verify", headers: { cookie: cookies(options) }, payload: { response: { id: b64(credentialId), rawId: b64(credentialId), type: "public-key", response: { clientDataJSON: b64(client), authenticatorData: b64(authenticator), signature: b64(signature), userHandle: b64(Buffer.from(user.id)) }, clientExtensionResults: {} } } });
    };
    const signedIn = await signIn(1);
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    expect(signedIn.json().data.user.id).toBe(user.id);
    expect(signedIn.cookies.some((cookie) => cookie.name === "access_token" && cookie.value)).toBe(true);
    const wrongOrigin = await signIn(2, "https://another-site.example");
    expect(wrongOrigin.statusCode).toBe(401);
    await User.updateOne({ _id: user._id }, { twoFactorEnabled: true, twoFactorSecret: "JBSWY3DPEHPK3PXP" });
    const secondFactor = await signIn(2);
    expect(secondFactor.statusCode, secondFactor.body).toBe(200);
    expect(secondFactor.json().data.twoFactorRequired).toBe(true);
    expect(secondFactor.cookies.some((cookie) => cookie.name === "access_token" && cookie.value)).toBe(false);
  });
});
