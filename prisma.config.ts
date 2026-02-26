// prisma.config.ts (at project root)
import "dotenv/config";  // Loads .env if you have one; safe even without it
import { defineConfig, env } from "@prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),  // Reads from your Codespaces secret
  },
  // Optional: add these if needed later
  // migrations: {
  //   path: "prisma/migrations",
  // },
});
