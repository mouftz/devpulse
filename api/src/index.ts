import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import 'dotenv/config'
import { authRoutes } from './routes/auth.js'

const app = Fastify({ logger: true })

app.register(cors, { origin: true })
app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev_secret' })
app.register(authRoutes, { prefix: '/auth' })

app.get('/health', async () => ({ status: 'ok' }))

const start = async () => {
  try {
    const port = Number(process.env.PORT ?? 3000)
    const host = process.env.HOST ?? '127.0.0.1'
    await app.listen({ port, host })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
