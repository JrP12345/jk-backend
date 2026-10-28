import sharp from "sharp";
import { detectMagicBytes } from "./fileSecurity.ts";

export const MAX_BRANDING_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 25_000_000;
const formats = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as const;

export class BrandingImageError extends Error {}

/** Decode pixels and re-encode public branding, discarding metadata and appended
 * content. Text in PNG provenance/JPEG XMP is not executable SVG/HTML content.
 * Keep the generic clinical-document scanner and upload ownership unchanged. */
export async function prepareBrandingImage(buffer: Buffer, contentType: string): Promise<Buffer> {
  const format = formats[contentType as keyof typeof formats];
  if (!format || detectMagicBytes(buffer) !== contentType) {
    throw new BrandingImageError("The image format does not match its file type. Export it as PNG, JPEG or WebP and try again.");
  }
  if (!buffer.length || buffer.length > MAX_BRANDING_IMAGE_BYTES) {
    throw new BrandingImageError("Select an image up to 5 MB.");
  }
  try {
    const image = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.format !== format) throw new BrandingImageError("Select a PNG, JPEG or WebP image.");
    if ((metadata.pages ?? 1) > 1) throw new BrandingImageError("Select a still image rather than an animated image.");
    // Auto-orient before removing EXIF. PNG transparency is retained. No resize,
    // metadata copying or source-buffer passthrough is used for public branding.
    const clean = await image.autoOrient().toFormat(format).toBuffer();
    if (clean.length > MAX_BRANDING_IMAGE_BYTES) throw new BrandingImageError("The processed image exceeds 5 MB. Export a smaller image and try again.");
    return clean;
  } catch (error) {
    if (error instanceof BrandingImageError) throw error;
    throw new BrandingImageError("The image could not be read. Export a valid PNG, JPEG or WebP under 25 megapixels and try again.");
  }
}
