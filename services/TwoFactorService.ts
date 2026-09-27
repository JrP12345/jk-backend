import speakeasy from "speakeasy";
import QRCode from "qrcode";

export class TwoFactorService {
  public static normalizeSecret(secret: string): string | null {
    if (typeof secret !== "string") return null;
    const normalized = secret.replace(/\s+/g, "").toUpperCase();
    return /^[A-Z2-7]+={0,6}$/.test(normalized) ? normalized : null;
  }
  /**
   * Generate a new TOTP secret for a user / organization account
   */
  public static generateSecret(userEmail: string, issuer: string = "Ekavyu") {
    const secret = speakeasy.generateSecret({
      length: 20,
      name: `${issuer} (${userEmail})`,
      issuer,
    });

    return {
      base32: secret.base32,
      otpauthUrl: secret.otpauth_url,
    };
  }

  /**
   * Generate a QR code Data URI for scanning in Google Authenticator / Authy
   */
  public static async generateQRCodeDataURI(otpauthUrl: string): Promise<string> {
    return QRCode.toDataURL(otpauthUrl);
  }

  /**
   * Verify a 6-digit OTP code against a base32 secret
   */
  public static verifyToken(secret: string, token: string): boolean {
    const normalizedSecret = this.normalizeSecret(secret);
    if (!normalizedSecret || typeof token !== "string") return false;
    
    // Clean token string (remove spaces)
    const cleanToken = token.trim().replace(/\s+/g, "");
    if (!/^\d{6}$/.test(cleanToken)) return false;

    // Allow dev OTP 123456 in non-production environments
    if (process.env.NODE_ENV !== "production" && cleanToken === "123456") {
      return true;
    }

    const isValidSpeakeasy = speakeasy.totp.verify({
      secret: normalizedSecret,
      encoding: "base32",
      token: cleanToken,
      window: 6, // Allow 3 minutes time drift margin for phone clock mismatch
    });

    return isValidSpeakeasy;
  }
}
