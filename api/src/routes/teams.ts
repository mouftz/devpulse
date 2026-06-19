import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import prisma from '../db.js'

type Session = { sub: string }

const tokenFrom = (request: FastifyRequest) =>
  request.headers.authorization?.replace(/^Bearer /, '') || request.cookies.devpulse_token

const authenticate = async (app: FastifyInstance, request: FastifyRequest, reply: FastifyReply) => {
  const token = tokenFrom(request)
  if (!token) return reply.code(401).send({ error: 'Not authenticated' })
  try {
    return app.jwt.verify<Session>(token).sub
  } catch {
    return reply.code(401).send({ error: 'Invalid session' })
  }
}

const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export async function teamRoutes(app: FastifyInstance) {
  app.get('/', async (request, reply) => {
    const userId = await authenticate(app, request, reply)
    if (typeof userId !== 'string') return
    const memberships = await prisma.teamMember.findMany({
      where: { userId },
      include: {
        team: {
          include: { _count: { select: { members: true, repos: true } } },
        },
      },
      orderBy: { joinedAt: 'asc' },
    })
    return {
      teams: memberships.map(({ role, team }) => ({
        id: team.id,
        name: team.name,
        slug: team.slug,
        role,
        members: team._count.members,
        repositories: team._count.repos,
      })),
    }
  })

  app.post<{ Body: { name?: string } }>('/', async (request, reply) => {
    const userId = await authenticate(app, request, reply)
    if (typeof userId !== 'string') return
    const name = request.body?.name?.trim()
    if (!name || name.length > 80) return reply.code(400).send({ error: 'Team name must be between 1 and 80 characters' })
    const baseSlug = slugify(name) || 'team'
    const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 8)}`
    const team = await prisma.$transaction(async (tx) => {
      const created = await tx.team.create({ data: { name, slug, ownerId: userId } })
      await tx.teamMember.create({ data: { teamId: created.id, userId, role: 'owner' } })
      return created
    })
    return reply.code(201).send({ team: { ...team, role: 'owner', members: 1, repositories: 0 } })
  })

  app.get<{ Params: { teamId: string } }>('/:teamId', async (request, reply) => {
    const userId = await authenticate(app, request, reply)
    if (typeof userId !== 'string') return
    const membership = await prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: request.params.teamId, userId } },
      include: {
        team: {
          include: {
            repos: { include: { repo: { include: { _count: { select: { commits: true, pullRequests: true } } } } } },
            members: { include: { user: { select: { id: true, username: true, avatarUrl: true } } } },
          },
        },
      },
    })
    if (!membership) return reply.code(404).send({ error: 'Team not found' })
    const repos = membership.team.repos.map(({ repo }) => repo)
    const repoIds = repos.map((repo) => repo.id)
    const [mergedPullRequests, reviews] = repoIds.length
      ? await Promise.all([
          prisma.pullRequest.count({ where: { repoId: { in: repoIds }, mergedAt: { not: null } } }),
          prisma.prReview.count({ where: { pr: { repoId: { in: repoIds } } } }),
        ])
      : [0, 0]
    return {
      team: { id: membership.team.id, name: membership.team.name, slug: membership.team.slug, role: membership.role },
      totals: {
        repositories: repos.length,
        commits: repos.reduce((sum, repo) => sum + repo._count.commits, 0),
        pullRequests: repos.reduce((sum, repo) => sum + repo._count.pullRequests, 0),
        mergedPullRequests,
        reviews,
      },
      repositories: repos.map((repo) => ({
        id: repo.id,
        provider: repo.provider,
        fullName: repo.fullName,
        commits: repo._count.commits,
        pullRequests: repo._count.pullRequests,
        lastSyncedAt: repo.lastSyncedAt,
      })),
      members: membership.team.members.map((member) => ({ ...member.user, role: member.role })),
    }
  })

  app.put<{ Params: { teamId: string }; Body: { repoIds?: string[] } }>('/:teamId/repos', async (request, reply) => {
    const userId = await authenticate(app, request, reply)
    if (typeof userId !== 'string') return
    const membership = await prisma.teamMember.findUnique({ where: { teamId_userId: { teamId: request.params.teamId, userId } } })
    if (!membership || !['owner', 'admin'].includes(membership.role)) return reply.code(403).send({ error: 'Team admin access required' })
    const repoIds = [...new Set(request.body?.repoIds ?? [])]
    const ownedRepos = await prisma.repo.findMany({ where: { id: { in: repoIds }, ownerId: userId }, select: { id: true } })
    if (ownedRepos.length !== repoIds.length) return reply.code(400).send({ error: 'Only repositories you own can be shared with a team' })
    await prisma.$transaction(async (tx) => {
      await tx.teamRepo.deleteMany({ where: { teamId: request.params.teamId } })
      if (repoIds.length) await tx.teamRepo.createMany({ data: repoIds.map((repoId) => ({ teamId: request.params.teamId, repoId })) })
    })
    return { repositories: repoIds.length }
  })

  app.post<{ Params: { teamId: string }; Body: { username?: string; role?: string } }>('/:teamId/members', async (request, reply) => {
    const userId = await authenticate(app, request, reply)
    if (typeof userId !== 'string') return
    const membership = await prisma.teamMember.findUnique({ where: { teamId_userId: { teamId: request.params.teamId, userId } } })
    if (!membership || !['owner', 'admin'].includes(membership.role)) return reply.code(403).send({ error: 'Team admin access required' })
    const username = request.body?.username?.trim()
    const role = request.body?.role === 'admin' ? 'admin' : 'member'
    if (!username) return reply.code(400).send({ error: 'GitHub username is required' })
    const user = await prisma.user.findFirst({ where: { username: { equals: username, mode: 'insensitive' } } })
    if (!user) return reply.code(404).send({ error: 'That user must sign in to DevPulse before being added' })
    const member = await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: request.params.teamId, userId: user.id } },
      create: { teamId: request.params.teamId, userId: user.id, role },
      update: { role },
    })
    return reply.code(201).send({ member: { userId: member.userId, role: member.role } })
  })
}
