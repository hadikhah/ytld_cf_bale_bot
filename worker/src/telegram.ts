// worker/src/telegram.ts
import { Env } from './worker';
import { triggerWorkflow } from './utils';

const MAX_DIRECT_SIZE = 20 * 1024 * 1024;  // 20 MB – Telegram's getFile limit

export async function processTelegramUpdate(env: Env, update: any) {
  const msg = update.message || update.channel_post;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  // ---------- Debug: show what we received ----------
  const debugInfo: string[] = [];
  if (msg.document) debugInfo.push(`📄 Document: ${msg.document.file_name || 'unknown'} (${msg.document.file_size || 0} bytes)`);
  if (msg.video)    debugInfo.push(`🎬 Video: ${msg.video.file_name || 'unknown'} (${msg.video.file_size || 0} bytes)`);
  if (msg.audio)    debugInfo.push(`🎵 Audio: ${msg.audio.file_name || 'unknown'} (${msg.audio.file_size || 0} bytes)`);
  if (msg.animation)debugInfo.push(`🎞️ Animation: ${msg.animation.file_name || 'unknown'} (${msg.animation.file_size || 0} bytes)`);
  if (msg.photo) {
    const largest = msg.photo[msg.photo.length - 1];
    debugInfo.push(`🖼️ Photo: ${largest.width}x${largest.height} (${largest.file_size || 0} bytes)`);
  }
  if (debugInfo.length > 0) {
    await sendTelegramMessage(env, chatId, `🔍 *Received:*\n${debugInfo.join('\n')}`);
  }

  // ---------- Link account ----------
  if (text && text.startsWith('/start ')) {
    const code = text.split(' ')[1];
    if (code) {
      const baleChatId = await env.USER_PLANS.get(`link_code:${code}`);
      if (baleChatId) {
        await env.USER_PLANS.put(`tg_to_bale:${chatId}`, baleChatId);
        await env.USER_PLANS.delete(`link_code:${code}`);
        await sendTelegramMessage(env, chatId, '✅ Your Telegram account has been linked to Bale! You can now forward messages.');
      } else {
        await sendTelegramMessage(env, chatId, '❌ Invalid or expired link code. Use /link in your Bale bot to get a new one.');
      }
    }
    return;
  }

  // ---------- Check linked ----------
  const baleChatId = await env.USER_PLANS.get(`tg_to_bale:${chatId}`);
  if (!baleChatId) {
    await sendTelegramMessage(env, chatId, '⚠️ You are not linked to Bale yet. Get a link code from the Bale bot using /link and then send it here as: /start <code>');
    return;
  }

  // ---------- Forward text ----------
  if (text && !text.startsWith('/')) {
    const sender = msg.from?.first_name || msg.from?.username || 'Telegram';
    const forwarded = `📩 *${escapeMarkdown(sender)}* (from Telegram):\n${escapeMarkdown(text)}`;
    await callBaleApi(env, 'sendMessage', {
      chat_id: baleChatId,
      text: forwarded,
      parse_mode: 'Markdown',
    });
    return;
  }

  // ---------- Handle files ----------
  const doc = msg.document;
  const video = msg.video;
  const audio = msg.audio;
  const voice = msg.voice;
  const photo = msg.photo?.slice(-1)[0];
  const animation = msg.animation;

  const fileId = doc?.file_id || video?.file_id || audio?.file_id || voice?.file_id || photo?.file_id || animation?.file_id;
  if (!fileId) return;

  let fileType: string;
  let fileName: string;
  let fileSize: number;

  if (animation) {
    fileType = 'animation';
    fileName = animation.file_name || `animation_${msg.message_id}.mp4`;
    fileSize = animation.file_size || 0;
  } else if (video) {
    fileType = 'video';
    fileName = video.file_name || `video_${msg.message_id}.mp4`;
    fileSize = video.file_size || 0;
  } else if (audio) {
    fileType = 'audio';
    fileName = audio.file_name || `audio_${msg.message_id}.mp3`;
    fileSize = audio.file_size || 0;
  } else if (voice) {
    fileType = 'voice';
    fileName = `voice_${msg.message_id}.ogg`;
    fileSize = voice.file_size || 0;
  } else if (photo) {
    fileType = 'photo';
    fileName = `photo_${msg.message_id}.jpg`;
    fileSize = photo.file_size || 0;
  } else if (doc) {
    fileType = 'document';
    fileName = doc.file_name || `file_${msg.message_id}`;
    fileSize = doc.file_size || 0;
  } else {
    return;
  }

  // ---------- Hard limit: Telegram bots cannot fetch files > 20 MB ----------
  if (fileSize > MAX_DIRECT_SIZE) {
    await sendTelegramMessage(env, chatId,
      `❌ File is too large (${(fileSize/1024/1024).toFixed(1)} MB). Telegram bots can only transfer files up to 20 MB.`
    );
    return;
  }

  const caption = msg.caption
    ? `📩 *${escapeMarkdown(msg.from?.first_name || 'Telegram')}*:\n${escapeMarkdown(msg.caption)}`
    : undefined;

  // ---------- Get download URL from Telegram ----------
  const fileInfo = await getTelegramFile(env, fileId);
  if (!fileInfo || !fileInfo.file_path) {
    console.error(`getFile failed for ${fileName} (${fileSize} bytes)`);
    await sendTelegramMessage(env, chatId, `❌ Could not retrieve file from Telegram. Please try again.`);
    return;
  }

  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

  // ---------- Forward to Bale ----------
  if (fileSize <= 15 * 1024 * 1024) {
    // Small file – download and re‑upload to Bale directly
    try {
      const fileResp = await fetch(fileUrl);
      if (!fileResp.ok) throw new Error('Download failed');
      const arrayBuf = await fileResp.arrayBuffer();
      const form = new FormData();
      form.append('chat_id', baleChatId);
      if (caption) form.append('caption', caption);
      form.append(fileType === 'animation' ? 'animation' : fileType, new File([arrayBuf], fileName));

      const method = fileType === 'photo' ? 'sendPhoto'
        : fileType === 'voice' ? 'sendVoice'
        : fileType === 'animation' ? 'sendAnimation'
        : 'sendDocument';
      const baleResp = await fetch(`https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/${method}`, {
        method: 'POST',
        body: form,
      });
      if (baleResp.ok) {
        await sendTelegramMessage(env, chatId, '✅ Forwarded to Bale.');
      } else {
        throw new Error(await baleResp.text());
      }
    } catch (e) {
      console.error('Direct send failed:', e);
      await sendTelegramMessage(env, chatId, '❌ Failed to send file directly. Trying workflow…');
      await triggerTelegramTransfer(env, baleChatId, fileUrl, fileName);
    }
  } else {
    // Medium file (15–20 MB) – dispatch workflow to avoid Worker memory limits
    await sendTelegramMessage(env, chatId, '📦 File is a bit large, processing via workflow…');
    await triggerTelegramTransfer(env, baleChatId, fileUrl, fileName);
  }
}

// ---------- helpers ----------

async function getTelegramFile(env: Env, fileId: string): Promise<{ file_path?: string } | null> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`getFile HTTP ${resp.status}: ${await resp.text()}`);
      return null;
    }
    const data: any = await resp.json();
    return data?.result;
  } catch (e) {
    console.error('getFile request error:', e);
    return null;
  }
}

async function sendTelegramMessage(env: Env, chatId: number | string, text: string) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
  });
}

async function triggerTelegramTransfer(env: Env, baleChatId: string, fileUrl: string, fileName: string) {
  await triggerWorkflow(env, {
    bale_chat_id: baleChatId,
    file_url: fileUrl,
    file_name: fileName,
  }, 'telegram_transfer.yml');
}

async function callBaleApi(env: Env, method: string, body: any) {
  const url = `https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/${method}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!resp.ok) console.error(`Bale API error (${method}):`, resp.status, data);
  return data;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_\[\]()~`>#+\-=|{}.!]/g, '\\$&');
}
