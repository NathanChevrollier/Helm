import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  CLIENT_ID: z.string().regex(/^\d{17,20}$/, "CLIENT_ID doit être un identifiant Discord valide"),
  GUILD_ID: z.string().regex(/^\d{17,20}$/, "GUILD_ID doit être un identifiant Discord valide"),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  GITHUB_REPO: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  SUGGESTION_CHANNEL_NAME: z.string().min(1).default("💡・suggestions"),
  BUG_CHANNEL_NAME: z.string().min(1).default("🐛・signalement-bugs"),
  GITHUB_BUG_LABEL: z.string().min(1).max(50).default("bug"),
  GITHUB_SUGGESTION_LABEL: z.string().min(1).max(50).default("enhancement"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Configuration d'environnement invalide: ${details}`);
  }
  return result.data;
}
