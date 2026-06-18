import got from 'got'

const rawMlServiceUrl = (process.env.ML_SERVICE_URL ?? '').replace(/\/$/, '')
const ML_SERVICE_URL = rawMlServiceUrl && !rawMlServiceUrl.includes('://')
  ? `http://${rawMlServiceUrl}`
  : rawMlServiceUrl
const ML_SERVICE_TOKEN = process.env.ML_SERVICE_TOKEN
const mlOptions = {
  timeout: { request: 120_000 },
  ...(ML_SERVICE_TOKEN ? { headers: { 'x-ml-service-token': ML_SERVICE_TOKEN } } : {}),
}

export const predictRepoCycleTimes = async (repoId: string) => {
  if (!ML_SERVICE_URL) return null

  try {
    return await got
      .post(`${ML_SERVICE_URL}/predict/repos/${repoId}`, mlOptions)
      .json<{ repoId: string; predictions: number; modelVersion: string; modelKind: string }>()
  } catch (error) {
    console.warn(`[ml] prediction skipped for repo ${repoId}:`, error instanceof Error ? error.message : error)
    return null
  }
}

export const trainPrCycleModel = async () => {
  if (!ML_SERVICE_URL) return null
  try {
    return await got
      .post(`${ML_SERVICE_URL}/train/pr-cycle`, mlOptions)
      .json<{ status: string; model_kind: string; model_version: string; training_rows: number }>()
  } catch (error) {
    console.warn('[ml] scheduled training skipped:', error instanceof Error ? error.message : error)
    return null
  }
}
