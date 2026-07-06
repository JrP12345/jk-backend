const { S3Client, PutBucketCorsCommand } = require('@aws-sdk/client-s3');

async function setCors() {
  const s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });

  const command = new PutBucketCorsCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedHeaders: ["*"],
          AllowedMethods: ["PUT", "POST", "DELETE", "GET", "HEAD"],
          AllowedOrigins: ["*"],
          ExposeHeaders: ["ETag"],
          MaxAgeSeconds: 3600
        }
      ]
    }
  });

  try {
    await s3Client.send(command);
    console.log("✅ CORS rules set successfully on R2 bucket:", process.env.R2_BUCKET_NAME);
  } catch (err) {
    console.error("❌ Failed to set CORS rules:", err);
  }
}

setCors();
