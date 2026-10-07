import { User } from "../../models/User.ts";
import { fixtureAccessToken } from "./sessionFixture.ts";
import { createAuthSession } from "../../utilities/helpers.ts";

/** Provision test tenants through the authenticated platform route. */
export async function provisioningFixtureHeaders() {
  const email = "platform-provisioning-fixture@example.test";
  const root = await User.findOne({ email, role: "root" }) || await User.create({ name: "Platform provisioning fixture", email, role: "root" });
  return { authorization: `Bearer ${await fixtureAccessToken({ id: root.id, email, role: "root" })}` };
}

/** Provisioning preserves Root's session; operational tests need explicit admin authority. */
export async function provisionedAdminCookies(response: { statusCode: number; body: string }): Promise<string[]> {
  if (response.statusCode !== 201) throw new Error("Organization fixture was not provisioned");
  const { user } = JSON.parse(response.body).data;
  if (!user?.id || user.role !== "admin" || !user.organization_id) throw new Error("Organization fixture has no administrator");
  const { accessToken, refreshToken } = await createAuthSession(user);
  return [`access_token=${accessToken}`, `refresh_token=${refreshToken}`];
}
