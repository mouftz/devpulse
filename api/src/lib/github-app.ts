import got, { HTTPError } from 'got'
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

export class GitHubInstallationTokenError extends Error {
  statusCode: number | undefined

  constructor(message: string, statusCode?: number) {
    super(message)
    this.name = 'GitHubInstallationTokenError'
    this.statusCode = statusCode
  }
}

export const exchangeInstallationToken = async (installationId: string, tier: AccessTier) => {
  const { appId } = getAppCredentials(tier)
  const token = signAppJwt(tier)

  try {
    return await got
      .post(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        headers: {
          ...githubHeaders,
          Authorization: `Bearer ${token}`,
        },
      })
      .json<InstallationAccessTokenResponse>()
  } catch (error) {
    if (error instanceof HTTPError) {
      const statusCode = error.response.statusCode
      if (statusCode === 404) {
        throw new GitHubInstallationTokenError(
          `GitHub installation ${installationId} does not belong to the ${tier} app (app id ${appId}). Reinstall the matching GitHub App or clear the stale installation on this user.`,
          statusCode,
        )
      }

      throw new GitHubInstallationTokenError(
        `GitHub installation token exchange failed for ${tier} app (app id ${appId}) with status ${statusCode}.`,
        statusCode,
      )
    }

    throw error
  }
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
      githubAppKind: true,
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
      githubAppKind: true,
    },
  })

  if (!user) {
    throw new Error('User not found')
  }

  const tier = (user.githubAppKind === 'standard' || user.githubAppKind === 'full'
    ? user.githubAppKind
    : user.accessTier ?? 'standard') as AccessTier

  const tokenExpiresAt = user.githubInstallationTokenExpiresAt?.getTime() ?? 0
  const refreshThresholdMs = 5 * 60 * 1000
  if (user.githubInstallationToken && tokenExpiresAt > Date.now() + refreshThresholdMs) {
    return decryptToken(user.githubInstallationToken)
  }

  if (user.githubInstallationId) {
    try {
      const refreshed = await exchangeInstallationToken(user.githubInstallationId, tier)
      await prisma.user.update({
        where: { id: userId },
        data: {
          githubInstallationToken: encryptToken(refreshed.token),
          githubInstallationTokenExpiresAt: new Date(refreshed.expires_at),
        },
      })
      return refreshed.token
    } catch (error) {
      if (!user.accessToken) throw error
    }
  }

  if (user.accessToken) {
    return decryptToken(user.accessToken)
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
