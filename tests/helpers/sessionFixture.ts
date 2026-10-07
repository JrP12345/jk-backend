import crypto from "node:crypto";
import { User } from "../../models/User.ts";
import { RefreshToken } from "../../models/RefreshToken.ts";
import { generateAccessToken } from "../../utilities/helpers.ts";
import type { JwtPayload } from "../../utilities/types.ts";

/** Persist session authority for route tests; login and session-policy tests use the real issuer. */
export async function fixtureAccessToken(payload: JwtPayload): Promise<string> {
  const user = await User.findById(payload.id).select("authVersion").lean();
  if (!user) throw new Error("Session fixture requires an existing identity");
  const authVersion = user.authVersion || 1;
  const session = await RefreshToken.create({
    userId: payload.id, organizationId: payload.organization_id,
    authVersion, isGuest: payload.role === "guest", impersonatedBy: payload.impersonatedBy,
    familyId: crypto.randomUUID(), generation: 1,
    tokenHash: crypto.randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });
  return generateAccessToken({ ...payload, sessionId: session.id, authVersion });
}
