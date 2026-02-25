/**
 * Discord Resolve Bot — Single-file Bun script
 *
 * 建立任務 → 定期 ping 指派者 → 按 Resolve 才停止
 *
 * ━━━ Setup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *   bun install discord.js pg
 *
 * ━━━ Environment Variables ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *   Required:
 *     DISCORD_TOKEN          Bot token (from Discord Developer Portal)
 *     DISCORD_CLIENT_ID      Bot application ID
 *     DATABASE_URL           PostgreSQL connection string
 *                            e.g. postgres://user:pass@host:5432/dbname
 *
 *   Optional:
 *     PING_CHECK_INTERVAL_MS   Scheduler tick interval (default: 60000 = 1 min)
 *     DEFAULT_INTERVAL_MIN     Default ping interval for new tasks (default: 30)
 *     DEFAULT_MAX_PINGS        Pings before escalation (default: 5)
 *     PORT                     Health check HTTP port (default: 8080)
 *     REGISTER_COMMANDS        Set to "1" on first run to register slash commands, then remove
 *
 * ━━━ Run ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 *   # First time — register commands to Discord
 *   REGISTER_COMMANDS=1 bun run resolve-bot.ts
 *
 *   # Normal run
 *   bun run resolve-bot.ts
 */

import {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ContextMenuCommandBuilder,
    ApplicationCommandType,
    UserSelectMenuBuilder,
    type ChatInputCommandInteraction,
    type ButtonInteraction,
    type UserSelectMenuInteraction,
    type MessageContextMenuCommandInteraction,
  } from "discord.js";
  import pg from "pg";
  
  // ─── Config ───────────────────────────────────────────────────────────────────
  
  const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
  const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID!;
  const DATABASE_URL = process.env.DATABASE_URL!;
  const PING_CHECK_INTERVAL_MS = Number(process.env.PING_CHECK_INTERVAL_MS ?? 60_000);
  const DEFAULT_INTERVAL_MIN = Number(process.env.DEFAULT_INTERVAL_MIN ?? 30);
  const DEFAULT_MAX_PINGS = Number(process.env.DEFAULT_MAX_PINGS ?? 5);
  const PORT = Number(process.env.PORT ?? 8080);
  
  for (const [k, v] of Object.entries({ DISCORD_TOKEN, DISCORD_CLIENT_ID, DATABASE_URL })) {
    if (!v) { console.error(`Missing env: ${k}`); process.exit(1); }
  }

  // ─── Discord Client ───────────────────────────────────────────────────────────

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
    ],
  });

  // ─── PostgreSQL ───────────────────────────────────────────────────────────────
  
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  
  async function initDB() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS resolve_tasks (
        task_id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        guild_id           TEXT NOT NULL,
        channel_id         TEXT NOT NULL,
        tracking_message_id TEXT,
        assignee_id        TEXT NOT NULL,
        creator_id         TEXT NOT NULL,
        description        TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','snoozed','resolved','cancelled')),
        interval_minutes   INT NOT NULL DEFAULT ${DEFAULT_INTERVAL_MIN},
        next_ping_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ping_count         INT NOT NULL DEFAULT 0,
        max_pings_before_escalate INT NOT NULL DEFAULT ${DEFAULT_MAX_PINGS},
        escalate_to_role_id TEXT,
        due_date           TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at        TIMESTAMPTZ,
        resolved_by        TEXT
      );

      ALTER TABLE resolve_tasks ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_tasks_active_ping
        ON resolve_tasks (next_ping_at)
        WHERE status IN ('active','snoozed');
    `);
    console.log("[db] tables ready");
  }
  
  // ─── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * 支援格式：
   *   明天 / 後天 / 下禮拜 / 下週
   *   M/D 或 MM/DD（當年；若已過則順延至明年）
   *   YYYY/MM/DD 或 YYYY-MM-DD
   *   M月D日
   */
  function parseDueDate(input: string): Date | null {
    const trimmed = input.trim();
    const today = new Date();
    today.setHours(23, 59, 59, 0);

    const relativeMap: Record<string, number> = {
      "明天": 1, "後天": 2, "下禮拜": 7, "下週": 7,
    };
    if (trimmed in relativeMap) {
      const d = new Date(today);
      d.setDate(d.getDate() + relativeMap[trimmed]);
      return d;
    }

    const chineseMatch = trimmed.match(/^(\d{1,2})月(\d{1,2})日?$/);
    if (chineseMatch) {
      return resolveMonthDay(parseInt(chineseMatch[1], 10), parseInt(chineseMatch[2], 10), today);
    }

    const shortSlashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (shortSlashMatch) {
      return resolveMonthDay(parseInt(shortSlashMatch[1], 10), parseInt(shortSlashMatch[2], 10), today);
    }

    const fullDateMatch = trimmed.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if (fullDateMatch) {
      const d = new Date(parseInt(fullDateMatch[1], 10), parseInt(fullDateMatch[2], 10) - 1, parseInt(fullDateMatch[3], 10), 23, 59, 59);
      return isNaN(d.getTime()) ? null : d;
    }

    return null;
  }

  function resolveMonthDay(month: number, day: number, today: Date): Date | null {
    const d = new Date(today.getFullYear(), month - 1, day, 23, 59, 59);
    if (isNaN(d.getTime())) return null;
    if (d < today) d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  /**
   * 解析延遲字串，回傳毫秒數。
   * 支援格式：30m、4h、1d（不區分大小寫）
   */
  function parseDelay(input: string): number | null {
    const match = input.trim().toLowerCase().match(/^(\d+)(m|h|d)$/);
    if (!match) return null;
    const amount = parseInt(match[1], 10);
    const unit = match[2];
    const multipliers: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
    return amount * multipliers[unit];
  }

  function taskEmbed(task: Record<string, unknown>, extra?: string) {
    const fields: { name: string; value: string; inline?: boolean }[] = [
      { name: "指派給", value: `<@${task.assignee_id}>`, inline: true },
      { name: "建立者", value: `<@${task.creator_id}>`, inline: true },
      { name: "狀態", value: statusLabel(String(task.status)), inline: true },
      { name: "已提醒", value: `${task.ping_count} 次`, inline: true },
      { name: "間隔", value: `${task.interval_minutes} 分鐘`, inline: true },
    ];

    if (task.due_date) {
      const ts = Math.floor(new Date(task.due_date as string).getTime() / 1000);
      fields.push({ name: "截止日期", value: `<t:${ts}:D>`, inline: true });
    }

    const e = new EmbedBuilder()
      .setTitle("📋 待處理任務")
      .setDescription(String(task.description))
      .addFields(fields)
      .setFooter({ text: `Task ID: ${task.task_id}` })
      .setTimestamp(new Date(task.created_at as string));

    if (extra) e.addFields({ name: "📌", value: extra });
    return e;
  }
  
  function statusLabel(s: string) {
    return { active: "🔴 Active", snoozed: "⏸️ Snoozed", resolved: "✅ Resolved", cancelled: "🗑️ Cancelled" }[s] ?? s;
  }
  
  function taskButtons(taskId: string, includeSnooze = true) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`resolve:${taskId}`).setLabel("Resolve").setStyle(ButtonStyle.Success).setEmoji("✅"),
    );
    if (includeSnooze) {
      row.addComponents(
        new ButtonBuilder().setCustomId(`snooze30:${taskId}`).setLabel("Snooze 30m").setStyle(ButtonStyle.Secondary).setEmoji("⏸️"),
        new ButtonBuilder().setCustomId(`snooze60:${taskId}`).setLabel("Snooze 1h").setStyle(ButtonStyle.Secondary).setEmoji("⏸️"),
      );
    }
    row.addComponents(
      new ButtonBuilder().setCustomId(`reassign:${taskId}`).setLabel("Reassign").setStyle(ButtonStyle.Primary).setEmoji("🔄"),
    );
    return row;
  }
  
  function resolvedButtons(taskId: string) {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`noop:${taskId}`).setLabel("✅ Resolved").setStyle(ButtonStyle.Secondary).setDisabled(true),
    );
  }
  
  // ─── Slash Command Definitions ────────────────────────────────────────────────
  
  const slashCommands = [
    new SlashCommandBuilder()
      .setName("task")
      .setDescription("管理 Resolve 任務")
      .addSubcommand((sub) =>
        sub.setName("create").setDescription("建立待處理任務")
          .addUserOption((o) => o.setName("assignee").setDescription("指派給誰").setRequired(true))
          .addStringOption((o) => o.setName("description").setDescription("任務描述").setRequired(true))
          .addStringOption((o) => o.setName("due_date").setDescription("截止日期（明天、後天、下禮拜、3/15、2026-03-15）"))
          .addStringOption((o) => o.setName("delay").setDescription("延遲首次提醒（例：4h、1d、30m）"))
          .addIntegerOption((o) => o.setName("interval").setDescription("Ping 間隔（分鐘）").setMinValue(1).setMaxValue(1440))
          .addRoleOption((o) => o.setName("escalate_to").setDescription("超時升級 ping 的 role"))
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("列出 active 任務")
      )
      .addSubcommand((sub) =>
        sub.setName("cancel").setDescription("取消任務")
          .addStringOption((o) => o.setName("task_id").setDescription("Task ID").setRequired(true))
      ),
  
    new ContextMenuCommandBuilder()
      .setName("📌 Create Resolve Task")
      .setType(ApplicationCommandType.Message),
  ];
  
  // ─── Register Commands ────────────────────────────────────────────────────────
  
  async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    console.log("[cmd] registering slash commands...");
    await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), {
      body: slashCommands.map((c) => c.toJSON()),
    });
    console.log("[cmd] done");
  }
  
  // ─── Command Handlers ─────────────────────────────────────────────────────────
  
  async function handleTaskCreate(i: ChatInputCommandInteraction) {
    const assignee = i.options.getUser("assignee", true);
    const description = i.options.getString("description", true);
    const interval = i.options.getInteger("interval") ?? DEFAULT_INTERVAL_MIN;
    const escalateRole = i.options.getRole("escalate_to");
    const dueDateInput = i.options.getString("due_date");
    const delayInput = i.options.getString("delay");

    let dueDate: Date | null = null;
    if (dueDateInput) {
      dueDate = parseDueDate(dueDateInput);
      if (!dueDate) {
        await i.reply({
          content: `❌ 無法解析截止日期「${dueDateInput}」，請輸入如：明天、後天、下禮拜、3/15、2026-03-15`,
          ephemeral: true,
        });
        return;
      }
    }

    let firstPingAt = new Date();
    if (delayInput) {
      const delayMs = parseDelay(delayInput);
      if (delayMs === null) {
        await i.reply({
          content: `❌ 無法解析延遲「${delayInput}」，請輸入如：30m、4h、1d`,
          ephemeral: true,
        });
        return;
      }
      firstPingAt = new Date(Date.now() + delayMs);
    }

    const { rows } = await pool.query(
      `INSERT INTO resolve_tasks (guild_id, channel_id, assignee_id, creator_id, description, interval_minutes, escalate_to_role_id, due_date, next_ping_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [i.guildId, i.channelId, assignee.id, i.user.id, description, interval, escalateRole?.id ?? null, dueDate?.toISOString() ?? null, firstPingAt.toISOString()]
    );
    const task = rows[0] as Record<string, unknown>;

    const delayNotice = delayInput
      ? `（將於 <t:${Math.floor(firstPingAt.getTime() / 1000)}:R> 開始提醒）`
      : "";

    const msg = await i.reply({
      content: `🔔 <@${assignee.id}> 你有一個新的待處理任務！${delayNotice}`,
      embeds: [taskEmbed(task)],
      components: [taskButtons(String(task.task_id))],
      fetchReply: true,
    });

    await pool.query(`UPDATE resolve_tasks SET tracking_message_id = $1 WHERE task_id = $2`, [msg.id, task.task_id]);
  }
  
  async function handleTaskList(i: ChatInputCommandInteraction) {
    const { rows } = await pool.query(
      `SELECT * FROM resolve_tasks WHERE guild_id = $1 AND status IN ('active','snoozed') ORDER BY created_at DESC LIMIT 20`,
      [i.guildId]
    );
  
    if (rows.length === 0) {
      await i.reply({ content: "目前沒有 active 任務 🎉", ephemeral: true });
      return;
    }
  
    const lines = rows.map((t: any, idx: number) =>
      `**${idx + 1}.** ${statusLabel(t.status)} <@${t.assignee_id}> — ${t.description.slice(0, 60)}${t.description.length > 60 ? "..." : ""}\n` +
      `　　已提醒 ${t.ping_count} 次 · 間隔 ${t.interval_minutes}m · \`${t.task_id.slice(0, 8)}\``
    );
  
    await i.reply({ content: lines.join("\n\n"), ephemeral: true });
  }
  
  async function handleTaskCancel(i: ChatInputCommandInteraction) {
    const taskId = i.options.getString("task_id", true);
    const { rowCount } = await pool.query(
      `UPDATE resolve_tasks SET status = 'cancelled' WHERE task_id = $1 AND guild_id = $2 AND status IN ('active','snoozed')`,
      [taskId, i.guildId]
    );
    if (rowCount === 0) {
      await i.reply({ content: "找不到該任務或已完成", ephemeral: true });
    } else {
      await i.reply({ content: `🗑️ 任務 \`${taskId.slice(0, 8)}\` 已取消` });
    }
  }
  
  async function handleContextMenu(i: MessageContextMenuCommandInteraction) {
    const msg = i.targetMessage;
    const description = msg.content?.slice(0, 500) || "(no content)";
  
    // 先建立任務（assignee 預設為訊息作者），然後讓使用者確認
    const { rows } = await pool.query(
      `INSERT INTO resolve_tasks (guild_id, channel_id, assignee_id, creator_id, description, interval_minutes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [i.guildId, i.channelId, msg.author.id, i.user.id, description, DEFAULT_INTERVAL_MIN]
    );
    const task = rows[0];
  
    const reply = await i.reply({
      content: `🔔 <@${msg.author.id}> 你有一個新的待處理任務！（來自[這則訊息](${msg.url})）`,
      embeds: [taskEmbed(task)],
      components: [taskButtons(task.task_id)],
      fetchReply: true,
    });
  
    await pool.query(`UPDATE resolve_tasks SET tracking_message_id = $1 WHERE task_id = $2`, [reply.id, task.task_id]);
  }
  
  // ─── Button Handlers ──────────────────────────────────────────────────────────
  
  async function handleResolve(i: ButtonInteraction, taskId: string) {
    const { rows } = await pool.query(
      `UPDATE resolve_tasks SET status = 'resolved', resolved_at = NOW(), resolved_by = $1
       WHERE task_id = $2 AND status IN ('active','snoozed') RETURNING *`,
      [i.user.id, taskId]
    );
  
    if (rows.length === 0) {
      await i.reply({ content: "該任務已完成或不存在", ephemeral: true });
      return;
    }
  
    const task = rows[0];
    await i.update({
      content: `✅ 任務已由 <@${i.user.id}> 完成！`,
      embeds: [taskEmbed(task, `由 <@${i.user.id}> 於 <t:${Math.floor(Date.now() / 1000)}:R> resolve`)],
      components: [resolvedButtons(taskId)],
    });
  }
  
  async function handleSnooze(i: ButtonInteraction, taskId: string, minutes: number) {
    const nextPing = new Date(Date.now() + minutes * 60_000);
  
    const { rows } = await pool.query(
      `UPDATE resolve_tasks SET status = 'snoozed', next_ping_at = $1
       WHERE task_id = $2 AND status IN ('active','snoozed') RETURNING *`,
      [nextPing.toISOString(), taskId]
    );
  
    if (rows.length === 0) {
      await i.reply({ content: "該任務已完成或不存在", ephemeral: true });
      return;
    }
  
    await i.reply({
      content: `⏸️ <@${i.user.id}> 已 snooze 此任務 ${minutes} 分鐘，將於 <t:${Math.floor(nextPing.getTime() / 1000)}:R> 繼續提醒`,
      ephemeral: true,
    });
  }
  
  async function handleReassignSelect(i: ButtonInteraction, taskId: string) {
    const row = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
      new UserSelectMenuBuilder().setCustomId(`reassign_select:${taskId}`).setPlaceholder("選擇新的 assignee").setMinValues(1).setMaxValues(1)
    );
    await i.reply({ content: "選擇要重新指派給誰：", components: [row], ephemeral: true });
  }
  
  async function handleReassignConfirm(i: UserSelectMenuInteraction, taskId: string) {
    const newAssignee = i.values[0];
  
    const { rows } = await pool.query(
      `UPDATE resolve_tasks SET assignee_id = $1, status = 'active', next_ping_at = NOW(), ping_count = 0
       WHERE task_id = $2 AND status IN ('active','snoozed') RETURNING *`,
      [newAssignee, taskId]
    );
  
    if (rows.length === 0) {
      await i.reply({ content: "該任務已完成或不存在", ephemeral: true });
      return;
    }
  
    await i.update({ content: `🔄 已重新指派給 <@${newAssignee}>`, components: [] });
  
    const task = rows[0];
    const channel = await client.channels.fetch(task.channel_id);
    if (channel?.isSendable()) {
      await channel.send({
        content: `🔔 <@${newAssignee}> 你有一個待處理任務（由 <@${i.user.id}> 轉派）！`,
        embeds: [taskEmbed(task)],
        components: [taskButtons(task.task_id)],
      });
    }
  }
  
  // ─── Ping Scheduler ───────────────────────────────────────────────────────────
  
  async function pingLoop() {
    try {
      // Snooze 到期的自動轉回 active
      await pool.query(
        `UPDATE resolve_tasks SET status = 'active' WHERE status = 'snoozed' AND next_ping_at <= NOW()`
      );
  
      // 撈出所有該 ping 的任務
      const { rows } = await pool.query(
        `SELECT * FROM resolve_tasks WHERE status = 'active' AND next_ping_at <= NOW()`
      );
  
      for (const task of rows) {
        try {
          const channel = await client.channels.fetch(task.channel_id);
          if (!channel?.isSendable()) continue;
  
          const isEscalation = task.ping_count >= task.max_pings_before_escalate && task.escalate_to_role_id;
  
          if (isEscalation) {
            await channel.send({
              content: `🚨 **ESCALATION** — 任務已提醒 ${task.ping_count} 次仍未處理！\n<@&${task.escalate_to_role_id}> <@${task.assignee_id}> 請立即處理：`,
              embeds: [taskEmbed(task, "⚠️ 已升級通知")],
              components: [taskButtons(task.task_id, false)],
            });
          } else {
            await channel.send({
              content: `🔔 提醒 #${task.ping_count + 1} — <@${task.assignee_id}>，你有待處理任務！`,
              embeds: [taskEmbed(task)],
              components: [taskButtons(task.task_id)],
            });
          }
  
          const nextPing = new Date(Date.now() + task.interval_minutes * 60_000);
          await pool.query(
            `UPDATE resolve_tasks SET ping_count = ping_count + 1, next_ping_at = $1 WHERE task_id = $2`,
            [nextPing.toISOString(), task.task_id]
          );
        } catch (err) {
          console.error(`[ping] error for task ${task.task_id}:`, err);
        }
      }
    } catch (err) {
      console.error("[ping] scheduler error:", err);
    }
  }
  
  // ─── Event Handlers ───────────────────────────────────────────────────────────
  
  client.on("interactionCreate", async (interaction) => {
    try {
      // Slash commands
      if (interaction.isChatInputCommand() && interaction.commandName === "task") {
        const sub = interaction.options.getSubcommand();
        if (sub === "create") return handleTaskCreate(interaction);
        if (sub === "list") return handleTaskList(interaction);
        if (sub === "cancel") return handleTaskCancel(interaction);
      }
  
      // Context menu
      if (interaction.isMessageContextMenuCommand() && interaction.commandName === "📌 Create Resolve Task") {
        return handleContextMenu(interaction);
      }
  
      // Buttons
      if (interaction.isButton()) {
        const [action, taskId] = interaction.customId.split(":");
        if (!taskId) return;
  
        if (action === "resolve") return handleResolve(interaction, taskId);
        if (action === "snooze30") return handleSnooze(interaction, taskId, 30);
        if (action === "snooze60") return handleSnooze(interaction, taskId, 60);
        if (action === "reassign") return handleReassignSelect(interaction, taskId);
      }
  
      // User select menu (reassign)
      if (interaction.isUserSelectMenu()) {
        const [action, taskId] = interaction.customId.split(":");
        if (action === "reassign_select" && taskId) {
          return handleReassignConfirm(interaction, taskId);
        }
      }
    } catch (err) {
      console.error("[interaction] error:", err);
      const reply = { content: "❌ 發生錯誤，請稍後再試", ephemeral: true };
      if (interaction.isRepliable()) {
        interaction.deferred || interaction.replied
          ? await interaction.followUp(reply).catch(() => {})
          : await interaction.reply(reply).catch(() => {});
      }
    }
  });
  
  client.once("ready", () => {
    console.log(`[bot] logged in as ${client.user?.tag}`);
    console.log(`[bot] ping check every ${PING_CHECK_INTERVAL_MS}ms, default interval ${DEFAULT_INTERVAL_MIN}min`);
  
    // Start ping scheduler
    setInterval(pingLoop, PING_CHECK_INTERVAL_MS);
  });
  
  // ─── Health Check Server (for Cloud Run / k8s) ───────────────────────────────
  
  Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok", uptime: process.uptime() });
      }
      return new Response("resolve-bot", { status: 200 });
    },
  });
  
  // ─── Main ─────────────────────────────────────────────────────────────────────
  
  async function main() {
    try {
      await initDB();
    } catch (err) {
      console.warn("[db] failed to connect, skipping DB init:", err);
    }

    if (process.env.REGISTER_COMMANDS === "1") {
      await registerCommands();
      console.log("[main] commands registered. Remove REGISTER_COMMANDS=1 and restart.");
      process.exit(0);
    }
  
    await client.login(DISCORD_TOKEN);
  }
  
  main().catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  });