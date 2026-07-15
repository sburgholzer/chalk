import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  type PutObjectCommandInput,
  type GetObjectCommandInput,
} from '@aws-sdk/client-s3';
import { type Result, ok, err } from '@/types/result';

export type S3Error =
  | { kind: 'UPLOAD_FAILURE'; cause: string }
  | { kind: 'DOWNLOAD_FAILURE'; cause: string }
  | { kind: 'NOT_FOUND'; key: string };

const BUCKET_NAME = process.env.CHALK_BUCKET_NAME ?? '';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const client = new S3Client({ region: REGION });

export async function uploadDocument(params: {
  key: string;
  body: string | Buffer;
  contentType: string;
}): Promise<Result<{ key: string; url: string }, S3Error>> {
  try {
    const input: PutObjectCommandInput = {
      Bucket: BUCKET_NAME,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    };

    await client.send(new PutObjectCommand(input));

    const url = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${params.key}`;

    return ok({ key: params.key, url });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown upload error';
    return err({ kind: 'UPLOAD_FAILURE', cause: message });
  }
}

export async function getDocument(
  key: string
): Promise<Result<{ body: string; contentType: string }, S3Error>> {
  try {
    const input: GetObjectCommandInput = {
      Bucket: BUCKET_NAME,
      Key: key,
    };

    const response = await client.send(new GetObjectCommand(input));

    if (!response.Body) {
      return err({ kind: 'NOT_FOUND', key });
    }

    const body = await response.Body.transformToString();
    const contentType = response.ContentType ?? 'application/octet-stream';

    return ok({ body, contentType });
  } catch (error: unknown) {
    if (isNoSuchKeyError(error)) {
      return err({ kind: 'NOT_FOUND', key });
    }
    const message = error instanceof Error ? error.message : 'Unknown download error';
    return err({ kind: 'DOWNLOAD_FAILURE', cause: message });
  }
}

function isNoSuchKeyError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const name = (error as { name?: string }).name;
    return name === 'NoSuchKey';
  }
  return false;
}
