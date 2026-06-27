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

type UserInstallationsResponse = {
  installations: Array<{
    id: number
    app_id: number
  }>
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
  const encryptedToken = encryptToken(installationToken.token)
  const expiresAt = new Date(installationToken.expires_at)

  await prisma.$transaction([
    prisma.gitHubInstallation.upsert({
      where: {
        userId_tier: {
          userId,
          tier,
        },
      },
      create: {
        userId,
        tier,
        installationId,
        installationToken: encryptedToken,
        installationTokenExpiresAt: expiresAt,
      },
      update: {
        installationId,
        installationToken: encryptedToken,
        installationTokenExpiresAt: expiresAt,
      },
    }),
    prisma.user.update({
      where: { id: userId },
      data: {
        githubInstallationId: installationId,
        githubInstallationToken: encryptedToken,
        githubInstallationTokenExpiresAt: expiresAt,
        githubAppKind: tier,
        accessTier: tier,
      },
    }),
  ])

  return prisma.gitHubInstallation.findUnique({
    where: {
      userId_tier: {
        userId,
        tier,
      },
    },
    select: {
      installationId: true,
      installationToken: true,
      installationTokenExpiresAt: true,
      tier: true,
    },
  })
}

const findUserInstallationForTier = async (accessToken: string, tier: AccessTier) => {
  const { appId } = getAppCredentials(tier)
  const installations = await got
    .get('https://api.github.com/user/installations', {
      headers: {
        ...githubHeaders,
        Authorization: `Bearer ${accessToken}`,
      },
      searchParams: { per_page: '100' },
    })
    .json<UserInstallationsResponse>()

  return installations.installations.find((installation) => String(installation.app_id) === String(appId))
}

export const storeUserInstallationTokenForTier = async (
  userId: string,
  accessToken: string,
  tier: AccessTier,
) => {
  const installation = await findUserInstallationForTier(accessToken, tier)
  if (!installation) return null
  return storeInstallationToken(userId, String(installation.id), tier)
}

export const getGitHubAccessTokenForUser = async (
  userId: string,
  options: { requireInstallationToken?: boolean; installationTier?: AccessTier } = {},
) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      accessToken: true,
      githubInstallationId: true,
      githubInstallationToken: true,
      githubInstallationTokenExpiresAt: true,
      accessTier: true,
      githubAppKind: true,
      githubInstallations: {
        select: {
          tier: true,
          installationId: true,
          installationToken: true,
          installationTokenExpiresAt: true,
        },
      },
    },
  })

  if (!user) {
    throw new Error('User not found')
  }

  const storedTier = (user.githubAppKind === 'standard' || user.githubAppKind === 'full'
    ? user.githubAppKind
    : user.accessTier ?? 'standard') as AccessTier
  const tier = options.installationTier ?? storedTier
  const tierInstallation = user.githubInstallations.find((installation) => installation.tier === tier)
  const storedInstallationTier = user.githubAppKind === 'standard' || user.githubAppKind === 'full'
    ? user.githubAppKind
    : null
  const fallbackInstallation = !tierInstallation && storedInstallationTier === tier && user.githubInstallationId && user.githubInstallationToken
    ? {
        tier,
        installationId: user.githubInstallationId,
        installationToken: user.githubInstallationToken,
        installationTokenExpiresAt: user.githubInstallationTokenExpiresAt,
      }
    : null
  const installation = tierInstallation ?? fallbackInstallation
  const tokenExpiresAt = installation?.installationTokenExpiresAt?.getTime() ?? 0
  const refreshThresholdMs = 5 * 60 * 1000
  if (installation?.installationToken && tokenExpiresAt > Date.now() + refreshThresholdMs) {
    return decryptToken(installation.installationToken)
  }

  if (installation?.installationId) {
    try {
      const refreshed = await exchangeInstallationToken(installation.installationId, tier)
      const encryptedToken = encryptToken(refreshed.token)
      const expiresAt = new Date(refreshed.expires_at)
      await prisma.$transaction([
        prisma.gitHubInstallation.upsert({
          where: {
            userId_tier: {
              userId,
              tier,
            },
          },
          create: {
            userId,
            tier,
            installationId: installation.installationId,
            installationToken: encryptedToken,
            installationTokenExpiresAt: expiresAt,
          },
          update: {
            installationToken: encryptedToken,
            installationTokenExpiresAt: expiresAt,
          },
        }),
        prisma.user.update({
          where: { id: userId },
          data: {
            githubInstallationId: installation.installationId,
            githubInstallationToken: encryptedToken,
            githubInstallationTokenExpiresAt: expiresAt,
            githubAppKind: tier,
          },
        }),
      ])
      return refreshed.token
    } catch (error) {
      if (options.requireInstallationToken || !user.accessToken) throw error
    }
  }

  if (options.requireInstallationToken) {
    if (user.accessToken) {
      const accessToken = decryptToken(user.accessToken)
      const stored = await storeUserInstallationTokenForTier(userId, accessToken, tier)
      if (stored?.installationToken) {
        return decryptToken(stored.installationToken)
      }
    }

    throw new Error('Finish Full setup and select this repository in GitHub before syncing private repositories')
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
