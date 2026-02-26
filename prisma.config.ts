import { defineConfig } from '@prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,  // or env("DATABASE_URL") if using Prisma's env helper
  },
});
