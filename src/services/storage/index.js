import crypto from 'node:crypto';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { env } from '../../config/env.js';
import { ApiError } from '../../middleware/error.js';

// One adapter so product images and scanned labels can live on S3-compatible
// storage in production and on local disk in development, without the callers
// knowing which.

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const MAX_BYTES = 8 * 1024 * 1024;

let s3 = null;
function client() {
  if (!s3) {
    s3 = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3;
}

function safeKey(filename, prefix) {
  const ext = path.extname(String(filename ?? '')).toLowerCase().slice(0, 6) || '.jpg';
  // Never trust the client's filename for the stored key.
  return `${prefix}/${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

/**
 * @param {Buffer} buffer
 * @param {{filename:string, contentType:string, prefix?:string}} opts
 * @returns {Promise<{url:string, key:string}>}
 */
export async function uploadFile(buffer, { filename, contentType, prefix = 'products' }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw ApiError.badRequest('No file was uploaded.', 'NO_FILE');
  }
  if (buffer.length > MAX_BYTES) {
    throw ApiError.badRequest('That image is too large (max 8MB).', 'FILE_TOO_LARGE');
  }
  if (!ALLOWED.has(contentType)) {
    throw ApiError.badRequest('Upload a JPG, PNG, WebP or AVIF image.', 'UNSUPPORTED_TYPE');
  }

  const key = safeKey(filename, prefix);

  if (env.STORAGE_DRIVER === 'local') {
    const dir = path.join(process.cwd(), 'uploads', prefix);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(process.cwd(), 'uploads', key), buffer);
    return { url: `${env.API_URL}/uploads/${key}`, key };
  }

  await client().send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  const base = env.S3_PUBLIC_BASE_URL ?? `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`;
  return { url: `${base.replace(/\/$/, '')}/${key}`, key };
}

export async function deleteFile(key) {
  if (env.STORAGE_DRIVER === 'local') return;
  await client().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}
