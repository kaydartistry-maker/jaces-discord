// Jace's Discord MCP Bridge v4.0
// Full feature parity: read, send, edit, delete, typing, images, emojis, stickers, voice
// Endpoints: /mcp + /sse

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_CDN = "https://cdn.discordapp.com";

const MAX_EMOTE_IMAGES_PER_READ = 10;
const MAX_EMBED_IMAGES_PER_READ = 10;
const MAX_ATTACHMENT_IMAGES_PER_READ = 10;

// ============ VOICE CONFIG ============
// Add Jace's ElevenLabs voice ID here when ready
const VOICE_MAP = {
  jace: "", // <-- DROP JACE'S ELEVENLABS VOICE ID HERE
};

// ============ HELPERS ============

const EMOTE_REGEX = /<(a?):(\w+):(\d+)>/g;

function resolveEmotes(content) {
  if (!content || typeof content !== "string") return [];

  const emotes = [];
  let match;
  EMOTE_REGEX.lastIndex = 0;

  while ((match = EMOTE_REGEX.exec(content)) !== null) {
    const animated = match[1] === "a";
    const name = match[2];
    const id = match[3];
    const extension = animated ? "gif" : "png";

    emotes.push({
      name,
      id,
      animated,
      url: `${DISCORD_CDN}/emojis/${id}.${extension}?size=128`,
      mimeType: animated ? "image/gif" : "image/png",
    });
  }

  return emotes;
}

function resolveEmbedImages(embeds) {
  if (!Array.isArray(embeds)) return [];

  const images = [];
  for (const embed of embeds) {
    if (embed.image?.url) {
      images.push({ url: embed.image.url, mimeType: "image/png", source: "embed-image" });
    } else if (embed.thumbnail?.url) {
      images.push({ url: embed.thumbnail.url, mimeType: "image/png", source: "embed-thumbnail" });
    } else if (embed.video?.url) {
      images.push({ url: embed.video.url, mimeType: "image/png", source: "embed-video" });
    }
  }

  return images;
}

function resolveImageAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];

  return attachments
    .filter((att) => (att.content_type || "").startsWith("image/"))
    .map((att) => ({
      url: att.url,
      filename: att.filename || "image",
      contentType: att.content_type || "image/png",
      mimeType: att.content_type || "image/png",
      size: att.size || 0,
    }));
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

function base64ToBlob(base64, mimeType = "image/png") {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

function extensionFromMimeType(mimeType = "image/png") {
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) return "jpg";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("webp")) return "webp";
  return "png";
}

async function fetchImageAsBlock(imageMeta) {
  try {
    const response = await fetch(imageMeta.url, {
      headers: { Accept: "image/gif,image/*" },
    });

    if (!response.ok) return null;

    const arrayBuffer = await response.arrayBuffer();
    const base64 = arrayBufferToBase64(arrayBuffer);
    const mimeType = response.headers.get("content-type") || imageMeta.mimeType || "image/png";

    return {
      type: "image",
      data: base64,
      mimeType,
    };
  } catch (err) {
    console.log("fetchImageAsBlock failed", err);
    return null;
  }
}

function getDiscordToken(env) {
  return env.DISCORD_TOKEN || env.DISCORD_BOT_TOKEN;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

// ============ TTS ============

async function generateTTS(text, apiKey, voiceId, outputFormat = "opus_48000_128") {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=${outputFormat}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error ${response.status}: ${errorText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

// ============ WAVEFORM ============

function generateWaveform(audioData, numPoints = 256) {
  const points = new Uint8Array(numPoints);
  const chunkSize = Math.floor(audioData.length / numPoints);

  for (let i = 0; i < numPoints; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, audioData.length);
    let max = 0;
    for (let j = start; j < end; j++) {
      const val = Math.abs(audioData[j] - 128);
      if (val > max) max = val;
    }
    points[i] = Math.min(255, max * 2);
  }

  return btoa(String.fromCharCode(...points));
}

// ============ DISCORD CLIENT ============

class DiscordClient {
  constructor(token) {
    this.token = token;
  }

  async request(endpoint, options = {}) {
    const response = await fetch(`${DISCORD_API}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`Discord API error ${response.status}: ${await response.text()}`);
    }

    if (response.status === 204) return {};
    return response.json();
  }

  // ---- Messages ----

  async readMessages(channelId, limit = 50) {
    const messages = await this.request(`/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`);
    return messages.reverse();
  }

  async sendMessage(channelId, content, replyToMessageId) {
    const body = { content };
    if (replyToMessageId) body.message_reference = { message_id: replyToMessageId };

    return this.request(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async editMessage(channelId, messageId, content) {
    return this.request(`/channels/${channelId}/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ content }),
    });
  }

  async deleteMessage(channelId, messageId) {
    await this.request(`/channels/${channelId}/messages/${messageId}`, {
      method: "DELETE",
    });
  }

  // ---- Typing ----

  async triggerTyping(channelId) {
    await this.request(`/channels/${channelId}/typing`, {
      method: "POST",
    });
  }

  // ---- Images ----

  async sendImage(channelId, imageInput, caption = "", replyToMessageId, mimeTypeArg = "image/png") {
    if (!imageInput || typeof imageInput !== "string") {
      throw new Error("Missing imageInput. Use imageInput or imageUrl.");
    }

    let blob;
    let mimeType = mimeTypeArg;

    if (imageInput.startsWith("data:image")) {
      const match = imageInput.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) throw new Error("Invalid data URI image");
      mimeType = match[1];
      blob = base64ToBlob(match[2], mimeType);
    } else if (imageInput.startsWith("http://") || imageInput.startsWith("https://")) {
      const img = await fetch(imageInput);
      if (!img.ok) throw new Error(`Image fetch failed ${img.status}: ${await img.text()}`);
      mimeType = img.headers.get("content-type") || mimeType;
      blob = await img.blob();
    } else {
      blob = base64ToBlob(imageInput, mimeType);
    }

    const filename = `image.${extensionFromMimeType(mimeType)}`;
    const payload = {
      content: caption,
      attachments: [{ id: 0, filename }],
    };

    if (replyToMessageId) payload.message_reference = { message_id: replyToMessageId };

    const form = new FormData();
    form.append("payload_json", JSON.stringify(payload));
    form.append("files[0]", blob, filename);

    const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.token}` },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Discord image send failed ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  // ---- File Attachments ----

  async sendFileAttachment(channelId, fileData, filename, contentType, messageContent) {
    const form = new FormData();
    const blob = new Blob([fileData], { type: contentType });
    form.append("files[0]", blob, filename);

    const payload = { attachments: [{ id: "0", filename }] };
    if (messageContent) payload.content = messageContent;
    form.append("payload_json", JSON.stringify(payload));

    const response = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${this.token}` },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Discord API error ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  // ---- Voice Messages ----

  async sendVoiceMessage(channelId, oggData, durationSecs, waveform) {
    // Step 1: Request pre-signed upload URL
    const uploadRequest = await this.request(`/channels/${channelId}/attachments`, {
      method: "POST",
      body: JSON.stringify({
        files: [{ filename: "voice-message.ogg", file_size: oggData.length, id: "0" }],
      }),
    });

    const { upload_url, upload_filename } = uploadRequest.attachments[0];

    // Step 2: Upload OGG to Discord CDN
    const uploadResponse = await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": "audio/ogg" },
      body: oggData,
    });

    if (!uploadResponse.ok) {
      throw new Error(`Discord upload error ${uploadResponse.status}: ${await uploadResponse.text()}`);
    }

    // Step 3: Send message with voice flag
    return this.request(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        flags: 8192,
        attachments: [{
          id: "0",
          filename: "voice-message.ogg",
          uploaded_filename: upload_filename,
          duration_secs: durationSecs,
          waveform: waveform,
        }],
      }),
    });
  }

  // ---- Search ----

  async searchMessages(guildId, params) {
    const searchParams = new URLSearchParams();
    if (params.content) searchParams.set("content", params.content);
    if (params.author_id) searchParams.set("author_id", params.author_id);
    if (params.channel_id) searchParams.set("channel_id", params.channel_id);
    if (params.has) searchParams.set("has", params.has);
    if (params.limit) searchParams.set("limit", String(Math.min(params.limit, 25)));

    return this.request(`/guilds/${guildId}/messages/search?${searchParams.toString()}`);
  }

  // ---- Reactions ----

  async addReaction(channelId, messageId, emoji) {
    const encodedEmoji = encodeURIComponent(emoji);
    await this.request(`/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`, {
      method: "PUT",
    });
  }

  // ---- Emojis ----

  async listEmojis(guildId) {
    return this.request(`/guilds/${guildId}/emojis`);
  }

  // ---- Stickers ----

  async listStickers(guildId) {
    return this.request(`/guilds/${guildId}/stickers`);
  }

  async sendSticker(channelId, stickerId) {
    return this.request(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ sticker_ids: [stickerId] }),
    });
  }

  // ---- Servers ----

  async listGuilds() {
    return this.request("/users/@me/guilds");
  }

  async getGuild(guildId) {
    return this.request(`/guilds/${guildId}?with_counts=true`);
  }

  async getGuildChannels(guildId) {
    return this.request(`/guilds/${guildId}/channels`);
  }
}

// ============ MCP TOOLS ============

// MCP tool annotations tell ChatGPT which tools need manual confirm:
//   readOnlyHint: true  → pure read, never prompts
//   destructiveHint: false → write but non-destructive, skips confirm
//   destructiveHint: true  → destructive action, keeps confirm gate

const TOOLS = [
  {
    name: "discord_read_messages",
    description: "Read messages from a Discord channel. Custom emotes, embedded images/GIFs, thumbnails, and uploaded image attachments are fetched and returned inline as image blocks.",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "The channel ID to read from" },
        limit: { type: "number", description: "Number of messages, max 100", default: 50 },
      },
      required: ["channelId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_send",
    description: "Send a text message to a Discord channel",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "The channel ID to send to" },
        message: { type: "string", description: "The message content" },
        replyToMessageId: { type: "string", description: "Optional message ID to reply to" },
      },
      required: ["channelId", "message"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_send_image",
    description: "Send an image to Discord from a URL, data URI, or raw base64 string",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "The channel ID to send to" },
        imageInput: { type: "string", description: "Image URL, data:image/...;base64,..., or raw base64" },
        imageUrl: { type: "string", description: "Alias for imageInput" },
        caption: { type: "string", description: "Optional caption" },
        replyToMessageId: { type: "string", description: "Optional message ID to reply to" },
        mimeType: { type: "string", description: "Optional MIME type for raw base64, like image/png" },
      },
      required: ["channelId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_search_messages",
    description: "Search for messages in a Discord server",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "The server/guild ID to search" },
        content: { type: "string", description: "Text to search for" },
        authorId: { type: "string", description: "Filter by author ID" },
        channelId: { type: "string", description: "Filter by channel ID" },
        has: { type: "string", description: "Filter by content type: link, embed, file, image, video" },
        limit: { type: "number", description: "Max results, default 25" },
      },
      required: ["guildId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_add_reaction",
    description: "Add a reaction to a message",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "The channel ID" },
        messageId: { type: "string", description: "The message ID to react to" },
        emoji: { type: "string", description: "The emoji to react with" },
      },
      required: ["channelId", "messageId", "emoji"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_list_servers",
    description: "List all Discord servers the bot is in",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_get_server_info",
    description: "Get detailed info about a Discord server including channels",
    inputSchema: {
      type: "object",
      properties: { guildId: { type: "string", description: "The server (guild) ID" } },
      required: ["guildId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_edit_message",
    description: "Edit a previously sent message",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "The channel ID" },
        messageId: { type: "string", description: "The message ID to edit" },
        content: { type: "string", description: "The new message content" },
      },
      required: ["channelId", "messageId", "content"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_delete_message",
    description: "Delete a message from a channel",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "The channel ID" },
        messageId: { type: "string", description: "The message ID to delete" },
      },
      required: ["channelId", "messageId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "discord_typing",
    description: "Show a typing indicator in a channel (lasts ~10 seconds)",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "The channel ID" },
      },
      required: ["channelId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_list_emojis",
    description: "List all custom emojis in a server",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "The server (guild) ID" },
      },
      required: ["guildId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_list_stickers",
    description: "List all stickers in a server",
    inputSchema: {
      type: "object",
      properties: {
        guildId: { type: "string", description: "The server (guild) ID" },
      },
      required: ["guildId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_send_sticker",
    description: "Send a sticker to a channel",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "The channel ID" },
        stickerId: { type: "string", description: "The sticker ID to send" },
      },
      required: ["channelId", "stickerId"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "discord_send_voice",
    description: "Generate a voice message using ElevenLabs TTS and send it as a native Discord voice message with waveform UI",
    inputSchema: {
      type: "object",
      properties: {
        channelId: { type: "string", description: "The channel ID to send to" },
        text: { type: "string", description: "The text to convert to speech (max 1000 chars)" },
        voice: { type: "string", description: 'Voice to use: "jace" (default)', default: "jace" },
      },
      required: ["channelId", "text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

// ============ TOOL HANDLERS ============

async function handleToolCall(client, name, args = {}, env = {}) {
  try {
    switch (name) {
      case "discord_read_messages": {
        const messages = await client.readMessages(args.channelId, args.limit || 50);

        const formattedMessages = [];
        const uniqueEmotes = new Map();
        const embedImagesList = [];
        const attachmentImagesList = [];

        for (const m of messages) {
          const emotes = resolveEmotes(m.content);
          const embedImages = resolveEmbedImages(m.embeds || []);
          const imageAttachments = resolveImageAttachments(m.attachments || []);

          for (const e of emotes) {
            if (!uniqueEmotes.has(e.url) && uniqueEmotes.size < MAX_EMOTE_IMAGES_PER_READ) {
              uniqueEmotes.set(e.url, e);
            }
          }

          for (const img of embedImages) {
            if (embedImagesList.length < MAX_EMBED_IMAGES_PER_READ) {
              embedImagesList.push({ messageId: m.id, image: img });
            }
          }

          for (const att of imageAttachments) {
            if (attachmentImagesList.length < MAX_ATTACHMENT_IMAGES_PER_READ) {
              attachmentImagesList.push({ messageId: m.id, attachment: att });
            }
          }

          formattedMessages.push({
            id: m.id,
            content: m.content,
            author: {
              id: m.author.id,
              username: m.author.username,
              bot: m.author.bot,
            },
            timestamp: m.timestamp,
            attachments: m.attachments?.length || 0,
            embeds: m.embeds?.length || 0,
            replyTo: m.message_reference?.message_id || null,
            emotes: emotes.map((e) => ({ name: e.name, id: e.id, animated: e.animated, url: e.url })),
            embedImages,
            imageAttachments,
          });
        }

        const contentBlocks = [
          {
            type: "text",
            text: JSON.stringify(
              { channelId: args.channelId, messageCount: formattedMessages.length, messages: formattedMessages },
              null,
              2
            ),
          },
        ];

        const emoteList = Array.from(uniqueEmotes.values());
        const emoteBlocks = await Promise.all(emoteList.map(fetchImageAsBlock));
        for (let i = 0; i < emoteList.length; i++) {
          if (emoteBlocks[i]) {
            contentBlocks.push({ type: "text", text: `Emote: :${emoteList[i].name}:` });
            contentBlocks.push(emoteBlocks[i]);
          }
        }

        const embedBlocks = await Promise.all(embedImagesList.map(({ image }) => fetchImageAsBlock(image)));
        for (let i = 0; i < embedImagesList.length; i++) {
          if (embedBlocks[i]) {
            contentBlocks.push({ type: "text", text: `Embed image from message ${embedImagesList[i].messageId}` });
            contentBlocks.push(embedBlocks[i]);
          }
        }

        const attachmentBlocks = await Promise.all(attachmentImagesList.map(({ attachment }) => fetchImageAsBlock(attachment)));
        for (let i = 0; i < attachmentImagesList.length; i++) {
          if (attachmentBlocks[i]) {
            const att = attachmentImagesList[i].attachment;
            contentBlocks.push({
              type: "text",
              text: `Attachment: ${att.filename} (${att.contentType}) from message ${attachmentImagesList[i].messageId}`,
            });
            contentBlocks.push(attachmentBlocks[i]);
          }
        }

        return { content: contentBlocks };
      }

      case "discord_send": {
        const msg = await client.sendMessage(args.channelId, args.message, args.replyToMessageId);
        return { content: [{ type: "text", text: JSON.stringify({ success: true, message_id: msg.id }, null, 2) }] };
      }

      case "discord_send_image": {
        const imageInput = args.imageInput || args.imageUrl;
        if (!imageInput) throw new Error("Missing imageInput or imageUrl");

        const msg = await client.sendImage(
          args.channelId,
          imageInput,
          args.caption || "",
          args.replyToMessageId,
          args.mimeType || "image/png"
        );

        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, message_id: msg.id }, null, 2) }],
        };
      }

      case "discord_search_messages": {
        const results = await client.searchMessages(args.guildId, {
          content: args.content,
          author_id: args.authorId,
          channel_id: args.channelId,
          has: args.has,
          limit: args.limit,
        });
        return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
      }

      case "discord_add_reaction": {
        await client.addReaction(args.channelId, args.messageId, args.emoji);
        return { content: [{ type: "text", text: `Added reaction ${args.emoji} to message ${args.messageId}` }] };
      }

      case "discord_list_servers": {
        const guilds = await client.listGuilds();
        return { content: [{ type: "text", text: JSON.stringify(guilds.map((g) => ({ id: g.id, name: g.name })), null, 2) }] };
      }

      case "discord_get_server_info": {
        const [guild, channels] = await Promise.all([client.getGuild(args.guildId), client.getGuildChannels(args.guildId)]);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: guild.id,
                  name: guild.name,
                  memberCount: guild.member_count,
                  channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "discord_edit_message": {
        await client.editMessage(args.channelId, args.messageId, args.content);
        return { content: [{ type: "text", text: `Message ${args.messageId} edited in ${args.channelId}` }] };
      }

      case "discord_delete_message": {
        await client.deleteMessage(args.channelId, args.messageId);
        return { content: [{ type: "text", text: `Message ${args.messageId} deleted from ${args.channelId}` }] };
      }

      case "discord_typing": {
        await client.triggerTyping(args.channelId);
        return { content: [{ type: "text", text: `Typing indicator triggered in ${args.channelId}` }] };
      }

      case "discord_list_emojis": {
        const emojis = await client.listEmojis(args.guildId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                emojis.map((e) => ({
                  id: e.id,
                  name: e.name,
                  animated: e.animated,
                  usage: `<${e.animated ? "a" : ""}:${e.name}:${e.id}>`,
                })),
                null,
                2
              ),
            },
          ],
        };
      }

      case "discord_list_stickers": {
        const stickers = await client.listStickers(args.guildId);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                stickers.map((s) => ({
                  id: s.id,
                  name: s.name,
                  description: s.description,
                  tags: s.tags,
                })),
                null,
                2
              ),
            },
          ],
        };
      }

      case "discord_send_sticker": {
        await client.sendSticker(args.channelId, args.stickerId);
        return { content: [{ type: "text", text: `Sticker ${args.stickerId} sent to ${args.channelId}` }] };
      }

      case "discord_send_voice": {
        const voiceName = (args.voice || "jace").toLowerCase();
        const voiceId = VOICE_MAP[voiceName] || VOICE_MAP.jace;

        if (!voiceId) {
          return {
            content: [{ type: "text", text: "Voice not configured yet — add Jace's ElevenLabs voice ID to the VOICE_MAP in the worker." }],
            isError: true,
          };
        }

        if (!env.ELEVENLABS_API_KEY) {
          return {
            content: [{ type: "text", text: "ELEVENLABS_API_KEY not set. Run: wrangler secret put ELEVENLABS_API_KEY" }],
            isError: true,
          };
        }

        const text = args.text.slice(0, 1000);
        const audioBytes = await generateTTS(text, env.ELEVENLABS_API_KEY, voiceId);

        // Check if OGG-wrapped Opus
        const isOgg = audioBytes[0] === 0x4F && audioBytes[1] === 0x67 &&
                      audioBytes[2] === 0x67 && audioBytes[3] === 0x53;

        if (isOgg) {
          const durationSecs = Math.max(1, Math.round(audioBytes.length / 16000));
          const waveform = generateWaveform(audioBytes);
          await client.sendVoiceMessage(args.channelId, audioBytes, durationSecs, waveform);

          return {
            content: [{ type: "text", text: `Native voice message sent to ${args.channelId} as ${voiceName} (${audioBytes.length} bytes, OGG/Opus)` }],
          };
        } else {
          const filename = "voice-message.opus";
          const mimeType = "audio/opus";
          await client.sendFileAttachment(args.channelId, audioBytes, filename, mimeType);

          return {
            content: [{ type: "text", text: `Voice message sent to ${args.channelId} as ${voiceName} (${audioBytes.length} bytes, attachment fallback)` }],
          };
        }
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { content: [{ type: "text", text: `Tool error: ${message}` }], isError: true };
  }
}

// ============ JSON-RPC ============

async function handleJsonRpc(body, client, env) {
  const requestId = body.id ?? 1;

  if (body.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: requestId,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "jaces-discord-tool", version: "4.0.0" },
      },
    };
  }

  if (body.method === "tools/list") {
    return { jsonrpc: "2.0", id: requestId, result: { tools: TOOLS } };
  }

  if (body.method === "tools/call") {
    if (!body.params?.name) {
      return { jsonrpc: "2.0", id: requestId, error: { code: -32602, message: "Missing tool name" } };
    }

    const result = await handleToolCall(client, body.params.name, body.params.arguments || {}, env);
    return { jsonrpc: "2.0", id: requestId, result };
  }

  return { jsonrpc: "2.0", id: requestId, error: { code: -32601, message: `Method not found: ${body.method}` } };
}

// ============ ROUTE HANDLERS ============

async function handleMCP(request, env) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });

  const token = getDiscordToken(env);
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing DISCORD_TOKEN or DISCORD_BOT_TOKEN" }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  const client = new DiscordClient(token);
  const body = await request.json();
  const response = await handleJsonRpc(body, client, env);

  return new Response(JSON.stringify(response), {
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

async function handleSSE(request, env, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

  if (request.method === "GET") {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const sessionId = crypto.randomUUID();

    const send = (event, data) => {
      return writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    };

    ctx.waitUntil(
      (async () => {
        try {
          await send("endpoint", `${new URL(request.url).origin}/sse?session=${sessionId}`);
          const interval = setInterval(() => writer.write(encoder.encode(": ping\n\n")).catch(() => {}), 30000);
          await new Promise((resolve) => setTimeout(resolve, 300000));
          clearInterval(interval);
          await writer.close();
        } catch (err) {
          try { await writer.close(); } catch {}
        }
      })()
    );

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        ...corsHeaders(),
      },
    });
  }

  if (request.method === "POST") {
    const token = getDiscordToken(env);
    if (!token) {
      return new Response(JSON.stringify({ error: "Missing DISCORD_TOKEN or DISCORD_BOT_TOKEN" }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    const client = new DiscordClient(token);
    const body = await request.json();
    const response = await handleJsonRpc(body, client, env);

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }

  return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
}

// ============ MAIN ============

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        JSON.stringify({
          name: "jaces-discord-tool",
          version: "4.0.0",
          status: "online",
          endpoints: { mcp: "/mcp", sse: "/sse" },
          tools: TOOLS.map((t) => t.name),
          features: [
            "read-attachments", "read-emotes", "read-embeds",
            "send-image-url", "send-base64",
            "edit-message", "delete-message", "typing-indicator",
            "emojis", "stickers", "voice-messages",
          ],
        }),
        { headers: { "Content-Type": "application/json", ...corsHeaders() } }
      );
    }

    if (url.pathname === "/mcp") return handleMCP(request, env);
    if (url.pathname === "/sse") return handleSSE(request, env, ctx);

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  },
};
