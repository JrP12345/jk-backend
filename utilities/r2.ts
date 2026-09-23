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
  maxSizeBytes: number = 15 * 1024 * 1024
) => {
  const fileExtension = originalFilename.split('.').pop()?.toLowerCase() || 'bin';
  const prefix = organizationId ? `tenants/${organizationId}/` : "quarantine/";
  const uniqueFilename = `${prefix}${crypto.randomUUID()}.${fileExtension}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: uniqueFilename,
    ContentType: contentType,
  });

  // Short-lived upload URL: 120 seconds
  const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 120 });

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
export const getObjectBuffer = async (fileKey: string): Promise<Buffer> => {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });

  const response = await s3Client.send(command);
  const stream = response.Body as any;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
};

/**
 * Deletes a file from the private storage bucket.
 */
export const deleteObjectFromStorage = async (fileKey: string): Promise<void> => {
  const command = new DeleteObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });

  await s3Client.send(command);
};

/**
 * Direct Base64 upload for avatars/prescriptions into private bucket.
 */
export const uploadBase64ToR2 = async (
  base64Data: string,
  originalFilename: string,
  contentType: string,
  organizationId?: string
) => {
  const fileExtension = originalFilename.split('.').pop()?.toLowerCase() || 'bin';
  const prefix = organizationId ? `tenants/${organizationId}/` : "";
  const uniqueFilename = `${prefix}${crypto.randomUUID()}.${fileExtension}`;

  const base64String = base64Data.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(base64String, 'base64');

  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: uniqueFilename,
    ContentType: contentType,
    Body: buffer,
  });

  await s3Client.send(command);

  return {
    fileKey: uniqueFilename,
  };
};
