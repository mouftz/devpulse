import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import 'dotenv/config'
import { authRoutes } from './routes/auth.js'
import { repoRoutes } from './routes/repos.js'

const app = Fastify({ logger: true })

app.register(cors, { credentials: true, origin: true })
app.register(cookie)
app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev_secret' })
app.register(authRoutes, { prefix: '/auth' })
app.register(repoRoutes, { prefix: '/github' })

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
