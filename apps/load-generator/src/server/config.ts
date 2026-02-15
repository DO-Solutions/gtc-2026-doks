export interface AppConfig {
  port: number;
  dynamoFrontendUrl: string;
  modelName: string;
  spacesEndpoint: string;
  spacesBucket: string;
  spacesRegion: string;
  spacesAccessKeyId: string;
  spacesSecretAccessKey: string;
  metricsWindowSec: number;
  defaultRPS: number;
  defaultMaxConcurrency: number;
  serverlessInferenceUrl: string;
  serverlessInferenceModel: string;
  gradientApiKey: string;
  k8sNamespace: string;
}

export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    dynamoFrontendUrl: process.env.DYNAMO_FRONTEND_URL
      || 'http://gtc-demo-frontend.dynamo-workload.svc.cluster.local:8000',
    modelName: process.env.MODEL_NAME
      || '/models/meta-llama/Llama-3.1-8B-Instruct',
    spacesEndpoint: process.env.SPACES_ENDPOINT
      || 'https://atl1.digitaloceanspaces.com',
    spacesBucket: process.env.SPACES_BUCKET || 'do-gtc2026-doks-demo',
    spacesRegion: process.env.SPACES_REGION || 'us-east-1',
    spacesAccessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    spacesSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    metricsWindowSec: parseInt(process.env.METRICS_WINDOW_SEC || '60', 10),
    defaultRPS: parseFloat(process.env.DEFAULT_RPS || '10'),
    defaultMaxConcurrency: parseInt(process.env.DEFAULT_MAX_CONCURRENCY || '35', 10),
    serverlessInferenceUrl: process.env.SERVERLESS_INFERENCE_URL
      || 'https://inference.do-ai.run/v1',
    serverlessInferenceModel: process.env.SERVERLESS_INFERENCE_MODEL
      || 'llama3.3-70b-instruct',
    gradientApiKey: process.env.GRADIENT_API_KEY || '',
    k8sNamespace: process.env.K8S_NAMESPACE || 'dynamo-workload',
  };
}
