import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import { authRoutes } from './routes/auth.js'
import { giteaRoutes } from './routes/gitea.js'
import { repoRoutes } from './routes/repos.js'

export const createApp = () => {
  const app = Fastify({ logger: true })

  app.register(cors, { credentials: true, origin: true })
  app.register(cookie)
  app.register(jwt, { secret: process.env.JWT_SECRET ?? 'dev_secret' })
  app.register(authRoutes, { prefix: '/auth' })
  app.register(repoRoutes, { prefix: '/github' })
  app.register(giteaRoutes, { prefix: '/gitea' })

  app.get('/health', async () => ({ status: 'ok' }))

  return app
}
