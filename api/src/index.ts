import 'dotenv/config'
import { createApp } from './app.js'

const app = createApp()

const start = async () => {
  try {
    const port = Number(process.env.PORT ?? 3000)
    const host = process.env.HOST ?? '127.0.0.1'
    await app.listen({ port, host })
    if (String(process.env.RUN_WORKER_IN_API ?? 'false') === 'true') {
      await import('./worker.js')
      app.log.info('Background sync worker started in API process')
    }
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
