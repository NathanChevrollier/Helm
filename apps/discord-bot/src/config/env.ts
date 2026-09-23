import "dotenv/config";
import { z } from "zod";

const optionalDiscordId = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().regex(/^\d{17,20}$/, "doit être un identifiant Discord valide").optional(),
);
const optionalProjectNumber = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().int().positive().optional(),
);

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  CLIENT_ID: z.string().regex(/^\d{17,20}$/, "CLIENT_ID doit être un identifiant Discord valide"),
  GUILD_ID: z.string().regex(/^\d{17,20}$/, "GUILD_ID doit être un identifiant Discord valide"),
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_OWNER: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  GITHUB_REPO: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  GITHUB_PROJECT_NUMBER: optionalProjectNumber,
  SUGGESTION_CHANNEL_ID: z.string().regex(/^\d{17,20}$/, "SUGGESTION_CHANNEL_ID doit être un identifiant Discord valide"),
  BUG_CHANNEL_ID: z.string().regex(/^\d{17,20}$/, "BUG_CHANNEL_ID doit être un identifiant Discord valide"),
  ROADMAP_CHANNEL_ID: optionalDiscordId,
  ROADMAP_MESSAGE_ID: optionalDiscordId,
  ROADMAP_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1440).default(15),
  GITHUB_BUG_LABEL: z.string().min(1).max(50).default("bug"),
  GITHUB_SUGGESTION_LABEL: z.string().min(1).max(50).default("enhancement"),
  GITHUB_BRAINSTORMING_LABEL: z.string().min(1).max(50).default("brainstorming"),
  GITHUB_IN_PROGRESS_LABEL: z.string().min(1).max(50).default("in-progress"),
  GITHUB_TEST_LABEL: z.string().min(1).max(50).default("test"),
  GITHUB_DONE_LABEL: z.string().min(1).max(50).default("done"),
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
