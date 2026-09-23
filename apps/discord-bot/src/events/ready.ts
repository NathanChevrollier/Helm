import { REST, Routes, type Client } from "discord.js";
import { commandDefinitions } from "../commands/index.js";
import type { Env } from "../config/env.js";

export async function registerCommands(client: Client<true>, env: Env): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(env.CLIENT_ID, env.GUILD_ID), { body: commandDefinitions });
  console.info(`[discord] connecté comme ${client.user.tag}`);
  console.info(`[discord] ${commandDefinitions.length} commandes enregistrées dans le serveur ${env.GUILD_ID}`);
}
