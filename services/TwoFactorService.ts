import speakeasy from "speakeasy";
import QRCode from "qrcode";

export class TwoFactorService {
  /**
   * Generate a new TOTP secret for a user / organization account
   */
  public static generateSecret(userEmail: string, issuer: string = "ANANTA") {
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
    if (!secret || !token) return false;
    
    // Clean token string (remove spaces)
    const cleanToken = token.trim().replace(/\s+/g, "");

    const isValidSpeakeasy = speakeasy.totp.verify({
      secret,
      encoding: "base32",
      token: cleanToken,
      window: 6, // Allow 3 minutes time drift margin for phone clock mismatch
    });

    if (isValidSpeakeasy) return true;

    // Dev/Test fallback for master bypass in local development
    if (process.env.NODE_ENV !== "production" && (cleanToken === "123456" || cleanToken === "894084")) {
      return true;
    }

    return false;
  }
}
