import got from 'got'
import jwt from 'jsonwebtoken'
const { sign: signJwt } = jwt
import prisma from '../db.js'
import { decryptToken, encryptToken } from './token-crypto.js'
import { getAppCredentials, type AccessTier } from './app-tiers.js'

type InstallationAccessTokenResponse = {
  token: string
  expires_at: string
}

const githubHeaders = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

const signAppJwt = (tier: AccessTier) => {
  const { appId, privateKey } = getAppCredentials(tier)

  return signJwt({}, privateKey, {
    algorithm: 'RS256',
    expiresIn: '9m',
    issuer: appId,
  })
}

export const exchangeInstallationToken = async (installationId: string, tier: AccessTier) => {
  const token = signAppJwt(tier)
  return got
    .post(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      headers: {
        ...githubHeaders,
        Authorization: `Bearer ${token}`,
      },
    })
    .json<InstallationAccessTokenResponse>()
}

export const storeInstallationToken = async (
  userId: string,
  installationId: string,
  tier: AccessTier,
) => {
  const installationToken = await exchangeInstallationToken(installationId, tier)
  return prisma.user.update({
    where: { id: userId },
    data: {
      githubInstallationId: installationId,
      githubInstallationToken: encryptToken(installationToken.token),
      githubInstallationTokenExpiresAt: new Date(installationToken.expires_at),
      githubAppKind: tier,
      accessTier: tier,
    },
    select: {
      githubInstallationId: true,
      githubInstallationToken: true,
      githubInstallationTokenExpiresAt: true,
      accessTier: true,
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
      accessTier: true,
    },
  })

  if (!user) {
    throw new Error('User not found')
  }

  const tier = (user.accessTier ?? 'standard') as AccessTier

  const tokenExpiresAt = user.githubInstallationTokenExpiresAt?.getTime() ?? 0
  const refreshThresholdMs = 5 * 60 * 1000
  if (user.githubInstallationToken && tokenExpiresAt > Date.now() + refreshThresholdMs) {
    return decryptToken(user.githubInstallationToken)
  }

  if (user.githubInstallationId) {
    const refreshed = await exchangeInstallationToken(user.githubInstallationId, tier)
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

export const uninstallGitHubAppInstallation = async (installationId: string, tier: AccessTier) => {
  await got.delete(
    `https://api.github.com/app/installations/${installationId}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${signAppJwt(tier)}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  )
}