import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'crypto';

// Initialize the S3 Client for Cloudflare R2
const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});

export const generatePresignedUrl = async (
  originalFilename: string,
  contentType: string,
  organizationId?: string
) => {
  // Generate a random, unique filename with tenant namespace to prevent collisions
  const fileExtension = originalFilename.split('.').pop() || 'bin';
  const prefix = organizationId ? `tenants/${organizationId}/` : "";
  const uniqueFilename = `${prefix}${crypto.randomUUID()}.${fileExtension}`;

  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: uniqueFilename,
    ContentType: contentType,
  });

  // Generate a URL that expires in 120 seconds
  const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 120 });

  return {
    uploadUrl: signedUrl,
    fileKey: uniqueFilename,
    // Add your custom domain for public images in production if applicable
    publicUrl: process.env.R2_CUSTOM_DOMAIN 
        ? `${process.env.R2_CUSTOM_DOMAIN}/${uniqueFilename}`
        : `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET_NAME}/${uniqueFilename}`
  };
};

export const uploadBase64ToR2 = async (
  base64Data: string,
  originalFilename: string,
  contentType: string,
  organizationId?: string
) => {
  const fileExtension = originalFilename.split('.').pop() || 'bin';
  const prefix = organizationId ? `tenants/${organizationId}/` : "";
  const uniqueFilename = `${prefix}${crypto.randomUUID()}.${fileExtension}`;

  const base64String = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64String, 'base64');

  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: uniqueFilename,
    ContentType: contentType,
    Body: buffer,
  });

  await s3Client.send(command);

  return {
    fileKey: uniqueFilename,
    publicUrl: process.env.R2_CUSTOM_DOMAIN 
        ? `${process.env.R2_CUSTOM_DOMAIN}/${uniqueFilename}`
        : `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${process.env.R2_BUCKET_NAME}/${uniqueFilename}`
  };
};
