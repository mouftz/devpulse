export type RetryableJob = {
  attempt?: number
}

export const retryAttempt = (job: RetryableJob) => job.attempt ?? 0

export const retryDelayMs = (attempt: number, baseDelayMs: number, maxDelayMs: number) =>
  Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt))

export const isRetryableSyncError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return !/token missing|required|invalid repo name|authentication failed|unauthorized|forbidden|connect github before syncing repositories|does not belong to the .* app/i.test(message)
}

export const shouldRetrySyncJob = (job: RetryableJob, error: unknown, maxAttempts: number) =>
  isRetryableSyncError(error) && retryAttempt(job) + 1 < maxAttempts
