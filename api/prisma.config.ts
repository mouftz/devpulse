import { defineConfig } from 'prisma/config'
import 'dotenv/config'

export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    // Migrations require a direct connection because transaction poolers can
    // retain Prisma's PostgreSQL advisory lock after a process disconnects.
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
  },
})
