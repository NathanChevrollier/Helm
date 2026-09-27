import { PermissionFlagsBits, SlashCommandBuilder, type RESTPostAPIChatInputApplicationCommandsJSONBody } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("setup-feedback")
    .setDescription("Publie les panneaux de suggestions et de signalement de bugs")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("bug").setDescription("Signaler un bug à l'équipe Zenytt"),
  new SlashCommandBuilder().setName("suggestion").setDescription("Proposer une amélioration pour Zenytt"),
  new SlashCommandBuilder()
    .setName("sync-roadmap")
    .setDescription("Met à jour le panneau public de la roadmap Zenytt")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder().setName("roadmap").setDescription("Afficher les chantiers actuels de Zenytt"),
  new SlashCommandBuilder()
    .setName("zenytt")
    .setDescription("Informations sur le bot et le projet Zenytt")
    .addSubcommand((subcommand) => subcommand.setName("status").setDescription("Afficher l'état du bot et la dernière release")),
].map((command) => command.toJSON()) satisfies RESTPostAPIChatInputApplicationCommandsJSONBody[];
