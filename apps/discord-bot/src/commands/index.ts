import { PermissionFlagsBits, SlashCommandBuilder, type RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("setup-feedback")
    .setDescription("Publie les panneaux de suggestions et de signalement de bugs")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("bug").setDescription("Signaler un bug à l'équipe Helm"),
  new SlashCommandBuilder().setName("suggestion").setDescription("Proposer une amélioration pour Helm"),
  new SlashCommandBuilder()
    .setName("helm")
    .setDescription("Informations sur le bot et le projet Helm")
    .addSubcommand((subcommand) => subcommand.setName("status").setDescription("Afficher l'état du bot et la dernière release")),
].map((command) => command.toJSON()) satisfies RESTPostAPIChatInputApplicationCommandsJSONBody[];
