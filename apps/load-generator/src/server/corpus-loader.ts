import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { AppConfig } from './config.js';
import type { SummarizationDoc, ReasoningPrompt } from './types.js';

export interface Corpus {
  summarizationDocs: SummarizationDoc[];
  reasoningPrompts: ReasoningPrompt[];
}

async function fetchJsonl<T>(s3: S3Client, bucket: string, key: string): Promise<T[]> {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  const resp = await s3.send(cmd);
  const body = await resp.Body?.transformToString('utf-8');
  if (!body) return [];
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export async function loadCorpus(config: AppConfig): Promise<Corpus> {
  const s3 = new S3Client({
    endpoint: config.spacesEndpoint,
    region: config.spacesRegion,
    credentials: {
      accessKeyId: config.spacesAccessKeyId,
      secretAccessKey: config.spacesSecretAccessKey,
    },
    forcePathStyle: false,
  });

  const bucket = config.spacesBucket;

  // Fetch summarization docs from all size buckets
  const [shortDocs, mediumDocs, longDocs] = await Promise.all([
    fetchJsonl<SummarizationDoc>(s3, bucket, 'corpus/summarization/short/docs.jsonl').catch(() => []),
    fetchJsonl<SummarizationDoc>(s3, bucket, 'corpus/summarization/medium/docs.jsonl').catch(() => []),
    fetchJsonl<SummarizationDoc>(s3, bucket, 'corpus/summarization/long/docs.jsonl').catch(() => []),
  ]);
  const summarizationDocs = [...shortDocs, ...mediumDocs, ...longDocs];

  const reasoningPrompts = await fetchJsonl<ReasoningPrompt>(
    s3, bucket, 'corpus/reasoning/prompts.jsonl'
  );

  console.log(
    `[corpus] Loaded ${summarizationDocs.length} summarization docs, ` +
    `${reasoningPrompts.length} reasoning prompts`
  );

  return { summarizationDocs, reasoningPrompts };
}
