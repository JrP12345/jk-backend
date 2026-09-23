/**
 * File Security Scanner & Magic Bytes Inspector
 * Inspects binary magic byte headers and detects active scripts/malicious payloads.
 */

export interface MagicByteResult {
  detectedMime: string | null;
  isValid: boolean;
  isSafe: boolean;
  rejectionReason?: string;
}

export function detectMagicBytes(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 4) return null;

  // PDF signature: %PDF- (0x25 0x50 0x44 0x46)
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return "application/pdf";
  }

  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG signature: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // WebP signature: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }

  // DICOM signature: "DICM" at byte offset 128
  if (buffer.length >= 132 && buffer.subarray(128, 132).toString("ascii") === "DICM") {
    return "application/dicom";
  }

  // Plain text / CSV: inspect printable UTF-8 without control bytes
  let isAsciiText = true;
  const sampleSize = Math.min(buffer.length, 1024);
  for (let i = 0; i < sampleSize; i++) {
    const byte = buffer[i];
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20 && byte !== 0x1b)) {
      isAsciiText = false;
      break;
    }
  }
  if (isAsciiText) {
    return "text/plain";
  }

  return null;
}

/**
 * Scans binary/text buffers for active malware patterns, executable headers,
 * and dangerous active SVG/HTML script injection.
 */
export function scanForActiveMaliciousContent(buffer: Buffer): { clean: boolean; threat?: string } {
  if (!buffer || buffer.length === 0) {
    return { clean: false, threat: "Empty file buffer" };
  }

  // Check for executable binary headers (DOS MZ / Windows PE / Linux ELF)
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return { clean: false, threat: "Windows Executable (MZ/PE) binary payload detected" };
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  ) {
    return { clean: false, threat: "Linux Executable (ELF) binary payload detected" };
  }

  // Check for active script injection in free text / SVG / XML
  const contentSnippet = buffer.subarray(0, Math.min(buffer.length, 65536)).toString("utf-8").toLowerCase();

  const DANGEROUS_PATTERNS = [
    /<script\b/i,
    /javascript:/i,
    /vbscript:/i,
    /<iframe\b/i,
    /<object\b/i,
    /<embed\b/i,
    /<applet\b/i,
    /onload\s*=/i,
    /onerror\s*=/i,
    /onclick\s*=/i,
    /onmouseover\s*=/i,
    /eval\s*\(/i,
    /document\.cookie/i,
  ];

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(contentSnippet)) {
      return {
        clean: false,
        threat: `Active malicious script or event handler detected matching pattern: ${pattern.toString()}`,
      };
    }
  }

  // Reject active SVG or HTML files that could execute client-side in browser
  if (contentSnippet.includes("<svg") || contentSnippet.includes("<!doctype html") || contentSnippet.includes("<html")) {
    return {
      clean: false,
      threat: "Active SVG/HTML files rejected to prevent Cross-Site Scripting (XSS). Upload as PDF or PNG.",
    };
  }

  return { clean: true };
}
