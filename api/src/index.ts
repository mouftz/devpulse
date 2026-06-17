import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import 'dotenv/config'

const app = Fastify({ logger: true })

app.register(cors, { origin: true })
app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev_secret' })

app.get('/health', async () => ({ status: 'ok' }))

const start = async () => {
  try {
    await app.listen({ port: 3000, host: '0.0.0.0' })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()