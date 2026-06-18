import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import { authRoutes } from './routes/auth.js'
import { giteaRoutes } from './routes/gitea.js'
import { repoRoutes } from './routes/repos.js'

export const createApp = () => {
  const isProduction = process.env.NODE_ENV === 'production'
  const jwtSecret = process.env.JWT_SECRET ?? (isProduction ? '' : 'dev_secret')
  if (!jwtSecret) throw new Error('JWT_SECRET is required in production')
  if (isProduction && !process.env.TOKEN_ENCRYPTION_KEY) {
    throw new Error('TOKEN_ENCRYPTION_KEY is required in production')
  }
  const frontendUrl = process.env.FRONTEND_URL
  const app = Fastify({ logger: true })

  app.register(cors, {
    credentials: true,
    origin: frontendUrl ? [frontendUrl] : !isProduction,
  })
  app.register(cookie)
  app.register(jwt, { secret: jwtSecret })
  app.register(authRoutes, { prefix: '/auth' })
  app.register(repoRoutes, { prefix: '/github' })
  app.register(giteaRoutes, { prefix: '/gitea' })

  app.get('/health', async () => ({ status: 'ok' }))

  return app
}
