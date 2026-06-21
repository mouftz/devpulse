import got from 'got'
import jwt from 'jsonwebtoken'
const { sign: signJwt } = jwt
import prisma from '../db.js'
import { decryptToken, encryptToken } from './token-crypto.js'

type InstallationAccessTokenResponse = {
  token: string
  expires_at: string
}

type GitHubInstallationTokenRecord = {
  githubInstallationId: string | null
  githubInstallationToken: string | null
  githubInstallationTokenExpiresAt: Date | null
  accessToken: string
}

const requiredEnv = (name: string) => {
  const value = process.env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

const normalizedPrivateKey = () =>
  requiredEnv('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n').trim()

const githubAppId = () => process.env.GITHUB_APP_ID!

const githubHeaders = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

const signAppJwt = () => {
  const appId = githubAppId()
  if (!appId) {
    throw new Error('GITHUB_APP_ID is required')
  }

  return signJwt({}, normalizedPrivateKey(), {
    algorithm: 'RS256',
    expiresIn: '9m',
    issuer: appId,
  })
}

export const exchangeInstallationToken = async (installationId: string) => {
  const token = signAppJwt()
  return got
    .post(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      headers: {
        ...githubHeaders,
        Authorization: `Bearer ${token}`,
      },
    })
    .json<InstallationAccessTokenResponse>()
}

export const storeInstallationToken = async (userId: string, installationId: string) => {
  const installationToken = await exchangeInstallationToken(installationId)
  return prisma.user.update({
    where: { id: userId },
    data: {
      githubInstallationId: installationId,
      githubInstallationToken: encryptToken(installationToken.token),
      githubInstallationTokenExpiresAt: new Date(installationToken.expires_at),
    },
    select: {
      githubInstallationId: true,
      githubInstallationToken: true,
      githubInstallationTokenExpiresAt: true,
    },
  })
}

export const getGitHubAccessTokenForUser = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      accessToken: true,
      githubInstallationId: true,
      githubInstallationToken: true,
      githubInstallationTokenExpiresAt: true,
    },
  })

  if (!user) {
    throw new Error('User not found')
  }

  const tokenExpiresAt = user.githubInstallationTokenExpiresAt?.getTime() ?? 0
  const refreshThresholdMs = 5 * 60 * 1000
  if (user.githubInstallationToken && tokenExpiresAt > Date.now() + refreshThresholdMs) {
    return decryptToken(user.githubInstallationToken)
  }

  if (user.githubInstallationId) {
    const refreshed = await exchangeInstallationToken(user.githubInstallationId)
    await prisma.user.update({
      where: { id: userId },
      data: {
        githubInstallationToken: encryptToken(refreshed.token),
        githubInstallationTokenExpiresAt: new Date(refreshed.expires_at),
      },
    })
    return refreshed.token
  }

  throw new Error('Connect GitHub before syncing repositories')
}

export const uninstallGitHubAppInstallation = async (installationId: string) => {
  await got.delete(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${signAppJwt()}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )
}