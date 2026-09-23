import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import type { Env } from "../config/env.js";
import { formatIssueBody, formatIssueTitle } from "../services/feedbackService.js";
import { GitHubService } from "../services/githubService.js";
import type { FeedbackInput, FeedbackKind } from "../types/feedback.js";

export function createInteractionHandler(client: Client, env: Env, github: GitHubService) {
  return async (interaction: Interaction): Promise<void> => {
    try {
      if (interaction.isChatInputCommand()) {
        await handleCommand(interaction, client, env, github);
        return;
      }
      if (interaction.isButton() && (interaction.customId === "feedback:bug" || interaction.customId === "feedback:suggestion")) {
        await showFeedbackModal(interaction.customId.slice("feedback:".length) as FeedbackKind, interaction);
        return;
      }
      if (interaction.isModalSubmit() && interaction.customId.startsWith("feedback-modal:")) {
        await handleFeedbackModal(interaction.customId.slice("feedback-modal:".length) as FeedbackKind, interaction, github);
      }
    } catch (error) {
      console.error("[interaction] traitement échoué:", error);
      await replyWithError(interaction);
    }
  };
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  client: Client,
  env: Env,
  github: GitHubService,
): Promise<void> {
  switch (interaction.commandName) {
    case "setup-feedback":
      await setupFeedback(interaction, env);
      break;
    case "bug":
      await showFeedbackModal("bug", interaction);
      break;
    case "suggestion":
      await showFeedbackModal("suggestion", interaction);
      break;
    case "helm":
      await showStatus(interaction, client, github);
      break;
  }
}

async function setupFeedback(interaction: ChatInputCommandInteraction, env: Env): Promise<void> {
  if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: "Seuls les membres ayant la permission Gérer le serveur peuvent utiliser cette commande.", ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Cette commande doit être utilisée dans un serveur Discord.", ephemeral: true });
    return;
  }
  const suggestionChannel = findTextChannel(guild.channels.cache.get(env.SUGGESTION_CHANNEL_ID));
  const bugChannel = findTextChannel(guild.channels.cache.get(env.BUG_CHANNEL_ID));
  const missing = [
    suggestionChannel ? undefined : `ID ${env.SUGGESTION_CHANNEL_ID}`,
    bugChannel ? undefined : `ID ${env.BUG_CHANNEL_ID}`,
  ].filter((name): name is string => name !== undefined);

  if (missing.length > 0 || !suggestionChannel || !bugChannel) {
    await interaction.reply({ content: `Salons introuvables: ${missing.join(", ")}. Crée-les ou ajuste le fichier .env.`, ephemeral: true });
    return;
  }

  await Promise.all([
    suggestionChannel.send({ embeds: [buildPanel("suggestion")], components: [buildButtonRow("suggestion")] }),
    bugChannel.send({ embeds: [buildPanel("bug")], components: [buildButtonRow("bug")] }),
  ]);
  await interaction.reply({ content: "Les panneaux de feedback ont été publiés.", ephemeral: true });
  console.info(`[feedback] panneaux publiés par ${interaction.user.tag}`);
}

async function showFeedbackModal(kind: FeedbackKind, interaction: ButtonInteraction | ChatInputCommandInteraction): Promise<void> {
  const isBug = kind === "bug";
  const modal = new ModalBuilder().setCustomId(`feedback-modal:${kind}`).setTitle(isBug ? "Signaler un bug" : "Proposer une amélioration");
  const title = new TextInputBuilder()
    .setCustomId("title")
    .setLabel("Titre court")
    .setPlaceholder(isBug ? "Ex: Le terminal se ferme au démarrage" : "Ex: Ajouter le support de ...")
    .setStyle(TextInputStyle.Short)
    .setMinLength(3)
    .setMaxLength(120)
    .setRequired(true);
  const description = new TextInputBuilder()
    .setCustomId("description")
    .setLabel(isBug ? "Description et étapes pour reproduire" : "Description de l'amélioration")
    .setPlaceholder(isBug ? "Étapes, résultat attendu, résultat obtenu..." : "Explique le besoin et le résultat attendu...")
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(10)
    .setMaxLength(4000)
    .setRequired(true);
  const context = new TextInputBuilder()
    .setCustomId("context")
    .setLabel("Contexte optionnel")
    .setPlaceholder("Version Helm, OS, priorité, logs utiles...")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(title),
    new ActionRowBuilder<TextInputBuilder>().addComponents(description),
    new ActionRowBuilder<TextInputBuilder>().addComponents(context),
  );
  await interaction.showModal(modal);
}

async function handleFeedbackModal(kind: FeedbackKind, interaction: ModalSubmitInteraction, github: GitHubService): Promise<void> {
  const title = interaction.fields.getTextInputValue("title").trim();
  const description = interaction.fields.getTextInputValue("description").trim();
  const context = interaction.fields.getTextInputValue("context").trim();
  const input: FeedbackInput = { kind, title, description, ...(context ? { context } : {}) };

  if (title.length < 3 || description.length < 10) {
    await interaction.reply({ content: "Le titre doit contenir au moins 3 caractères et la description au moins 10 caractères.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const issue = await github.createIssue(
    formatIssueTitle(input),
    formatIssueBody(input, {
      id: interaction.user.id,
      username: interaction.user.tag,
      avatarUrl: interaction.user.displayAvatarURL({ extension: "png", size: 128 }),
    }),
    kind,
  );
  await interaction.editReply(`Merci pour ton retour. L'issue GitHub **#${issue.number}** a été créée : ${issue.url}`);
  console.info(`[feedback] issue #${issue.number} créée par ${interaction.user.tag} (${kind})`);
}

async function showStatus(interaction: ChatInputCommandInteraction, client: Client, github: GitHubService): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const release = await github.getLatestRelease();
  const releaseText = release ? `[${release.tagName}](${release.url})` : "Aucune release publiée";
  await interaction.editReply(`**Helm Community Bot**\nÉtat : en ligne\nPing Discord : ${client.ws.ping} ms\nUptime : ${formatDuration(client.uptime ?? 0)}\nDernière release Helm : ${releaseText}`);
}

function buildPanel(kind: FeedbackKind): EmbedBuilder {
  const isBug = kind === "bug";
  return new EmbedBuilder()
    .setColor(isBug ? 0xd73a4a : 0x2ea043)
    .setTitle(isBug ? "Signaler un bug" : "Proposer une amélioration")
    .setDescription(
      isBug
        ? "Tu as rencontré un problème dans Helm ? Décris-le avec les étapes pour le reproduire afin que l'équipe puisse l'analyser."
        : "Une idée pour rendre Helm plus utile ? Partage-la avec la communauté et l'équipe de développement.",
    )
    .setFooter({ text: "Un formulaire Discord ouvrira les champs nécessaires." });
}

function buildButtonRow(kind: FeedbackKind): ActionRowBuilder<ButtonBuilder> {
  const button = new ButtonBuilder()
    .setCustomId(`feedback:${kind}`)
    .setLabel(kind === "bug" ? "Signaler un bug" : "Proposer une amélioration")
    .setEmoji(kind === "bug" ? "🐛" : "💡")
    .setStyle(kind === "bug" ? ButtonStyle.Danger : ButtonStyle.Success);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

function findTextChannel(channel: unknown): TextChannel | undefined {
  return isTextChannel(channel) ? channel : undefined;
}

function isTextChannel(channel: unknown): channel is TextChannel {
  return typeof channel === "object" && channel !== null && "type" in channel && channel.type === ChannelType.GuildText && "send" in channel;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

async function replyWithError(interaction: Interaction): Promise<void> {
  const payload = { content: "Une erreur est survenue. Réessaie dans quelques instants ou contacte un administrateur.", ephemeral: true };
  try {
    if (interaction.isRepliable()) {
      if (interaction.replied) await interaction.followUp(payload);
      else if (interaction.deferred) await interaction.editReply(payload.content);
      else await interaction.reply(payload);
    }
  } catch (replyError) {
    console.error("[interaction] impossible d'envoyer l'erreur à Discord:", replyError);
  }
}

