import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

// Initialize the S3 Client for Cloudflare R2
export const s3Client = new S3Client({
  region: 'auto',
  endpoint: process.env.CLOUDFLARE_ACCOUNT_ID 
    ? `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`
    : undefined,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME || 'healthos-private-vault';

/**
 * Generates an upload URL for a strictly private bucket.
 * Bucket is private: public access is forbidden.
 */
export const generatePresignedUrl = async (
  originalFilename: string,
  contentType: string,
  organizationId?: string,
  maxSizeBytes: number = 15 * 1024 * 1024,
  contentLength?: number,
) => {
  if (!Number.isSafeInteger(contentLength) || contentLength! <= 0 || contentLength! > maxSizeBytes) throw new Error('Valid upload content length is required');
  const fileExtension = originalFilename.split('.').pop()?.toLowerCase() || 'bin';
  const prefix = organizationId ? `upload-staging/${organizationId}/` : "quarantine/";
  const uniqueFilename = `${prefix}${crypto.randomUUID()}.${fileExtension}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: uniqueFilename,
    ContentType: contentType,
    ContentLength: contentLength,
  });

  // Short-lived upload URL: 120 seconds
  const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 120, signableHeaders: new Set(['content-type', 'content-length']) });

  return {
    uploadUrl: signedUrl,
    fileKey: uniqueFilename,
  };
};

/**
 * Generates a short-lived, authorization-checked presigned download URL for private files.
 * Default expiry: 300 seconds (5 minutes).
 */
export const generatePresignedDownloadUrl = async (
  fileKey: string,
  expiresInSeconds: number = 300
): Promise<string> => {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
    ResponseContentDisposition: 'attachment',
  });

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
};

/**
 * Retrieves object metadata (existence, content length, content type).
 */
export const getObjectMetadata = async (fileKey: string) => {
  const command = new HeadObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });

  return s3Client.send(command);
};

/**
 * Downloads object bytes for magic byte verification and malware scanning.
 */
export const getObjectBuffer = async (fileKey: string, maxBytes = 50 * 1024 * 1024): Promise<Buffer> => {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });

  const abort = new AbortController();
  let stream: any;
  const timer = setTimeout(() => { abort.abort(); stream?.destroy?.(new Error('UPLOAD_TIMEOUT')); }, 30000);
  try {
  const response = await s3Client.send(command, { abortSignal: abort.signal });
  stream = response.Body as any;
  if (!stream || (response.ContentLength !== undefined && response.ContentLength > maxBytes)) {
    stream?.destroy?.();
    throw new Error('UPLOAD_TOO_LARGE');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > maxBytes || abort.signal.aborted) {
      stream.destroy?.();
      throw new Error(length > maxBytes ? 'UPLOAD_TOO_LARGE' : 'UPLOAD_TIMEOUT');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
  } finally { clearTimeout(timer); }
};

/** Server-generated destination has never been exposed through a writable URL. */
export async function storeVerifiedObject(buffer: Buffer, contentType: string, organizationId: string) {
  const extensions: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'application/pdf': 'pdf', 'application/dicom': 'dcm', 'text/plain': 'txt', 'text/csv': 'csv' };
  const objectKey = `tenants/${organizationId}/verified/${crypto.randomUUID()}.${extensions[contentType] || 'bin'}`;
  await s3Client.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: objectKey, ContentType: contentType, Body: buffer }), { abortSignal: AbortSignal.timeout(30000) });
  return objectKey;
}

/**
 * Deletes a file from the private storage bucket.
 */
export const deleteObjectFromStorage = async (fileKey: string): Promise<void> => {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });

  await s3Client.send(command, { abortSignal: AbortSignal.timeout(8_000) });
};

export async function uploadOrganizationImage(buffer: Buffer, contentType: string, ownerId: string) {
  const extension = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";
  const objectKey = `organization-branding/${ownerId}/${crypto.randomUUID()}.${extension}`;
  await s3Client.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: objectKey, ContentType: contentType, Body: buffer }));
  return objectKey;
}

/**
 * Direct Base64 upload for avatars/prescriptions into private bucket.
 */
/** Compatibility helper; request authority must be checked by its caller. */
export const uploadBase64ToR2 = async (base64Data: string, originalFilename: string, contentType: string, organizationId?: string) => {
  const { validateUploadMetadata, validateUploadBytes, normalizeUploadMime } = await import('./uploadPolicy.ts');
  const maxBytes = 10 * 1024 * 1024;
  if (!organizationId || validateUploadMetadata(originalFilename, contentType, 'other') ||
      typeof base64Data !== 'string' || base64Data.length > Math.ceil(maxBytes / 3) * 4 + 256) throw new Error('Invalid upload');
  const buffer = Buffer.from(base64Data.replace(/^data:[^;]+;base64,/, ''), 'base64');
  validateUploadBytes(buffer, contentType, maxBytes);
  return { fileKey: await storeVerifiedObject(buffer, normalizeUploadMime(contentType), organizationId) };
};
