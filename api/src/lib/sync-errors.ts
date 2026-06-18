const MAX_SYNC_ERROR_LENGTH = 320

const statusCodeLabel = (statusCode: number) => {
  if (statusCode === 401 || statusCode === 403) return 'Provider authentication failed'
  if (statusCode === 404) return 'Provider resource not found'
  if (statusCode === 409) return 'Provider reported a sync conflict'
  if (statusCode === 422) return 'Provider rejected the sync request'
  if (statusCode >= 500) return 'Provider service is unavailable'
  return `Provider request failed (${statusCode})`
}

export const normalizeSyncError = (error: unknown) => {
  if (error instanceof Error) {
    const maybeStatusCode = Reflect.get(error, 'response') && Reflect.get(Reflect.get(error, 'response') as object, 'statusCode')
    if (typeof maybeStatusCode === 'number') {
      return statusCodeLabel(maybeStatusCode)
    }

    const message = error.message.trim()
    if (!message) return 'Unknown sync error'
    return message.length > MAX_SYNC_ERROR_LENGTH ? `${message.slice(0, MAX_SYNC_ERROR_LENGTH - 1)}...` : message
  }

  if (typeof error === 'string' && error.trim()) {
    return error.trim().slice(0, MAX_SYNC_ERROR_LENGTH)
  }

  return 'Unknown sync error'
}
