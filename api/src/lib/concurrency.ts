export const mapWithConcurrency = async <Input, Output>(
  items: readonly Input[],
  concurrency: number,
  mapper: (item: Input, index: number) => Promise<Output>,
) => {
  if (items.length === 0) return []
  const limit = Math.max(1, Math.min(items.length, Math.floor(concurrency) || 1))
  const results = new Array<Output>(items.length)
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await mapper(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return results
}
