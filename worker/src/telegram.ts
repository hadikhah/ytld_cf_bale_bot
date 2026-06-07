// worker/src/telegram.ts
export async function processTelegramUpdate(env: Env, update: any) {
  const msg = update.message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  // Handle linking code from Bale
  if (text && text.startsWith('/start ')) {
    const code = text.split(' ')[1];
    if (code) {
      const baleChatId = await env.USER_PLANS.get(`link_code:${code}`);
      if (baleChatId) {
        await env.USER_PLANS.put(`tg_to_bale:${chatId}`, baleChatId);
        await env.USER_PLANS.delete(`link_code:${code}`);
        await sendTelegramMessage(env, chatId, '✅ Your Telegram account has been linked to Bale! You can now forward files.');
      } else {
        await sendTelegramMessage(env, chatId, '❌ Invalid or expired link code. Use /link in your Bale bot to get a new one.');
      }
    }
    return;
  }

  // Check if user is linked
  const baleChatId = await env.USER_PLANS.get(`tg_to_bale:${chatId}`);
  if (!baleChatId) {
    await sendTelegramMessage(env, chatId, '⚠️ You are not linked to Bale yet. Get a link code from the Bale bot using /link and then send it here as: /start <code>');
    return;
  }

  // Process files
  const fileId = msg.document?.file_id || msg.video?.file_id || msg.audio?.file_id || msg.voice?.file_id;
  if (!fileId) return;

  const fileType = msg.document ? 'document' : msg.video ? 'video' : msg.audio ? 'audio' : 'voice';
  const fileName = msg.document?.file_name || `${fileType}_${msg.message_id}`;
  const fileSize = msg.document?.file_size || msg.video?.file_size || msg.audio?.file_size || msg.voice?.file_size || 0;

  // Get file path from Telegram
  const fileInfo = await getTelegramFile(env, fileId);
  if (!fileInfo || !fileInfo.file_path) {
    await sendTelegramMessage(env, chatId, '❌ Failed to fetch file info.');
    return;
  }

  const fileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

  if (fileSize > 0 && fileSize <= 15 * 1024 * 1024) {
    // Download and send directly to Bale
    try {
      const fileResp = await fetch(fileUrl);
      if (!fileResp.ok) throw new Error('Download failed');
      const arrayBuf = await fileResp.arrayBuffer();
      const form = new FormData();
      form.append('chat_id', baleChatId);
      form.append(fileType, new File([arrayBuf], fileName));
      const baleResp = await fetch(`https://tapi.bale.ai/bot${env.BALE_BOT_TOKEN}/send${capitalize(fileType)}`, {
        method: 'POST',
        body: form,
      });
      if (baleResp.ok) {
        await sendTelegramMessage(env, chatId, '✅ File forwarded to Bale.');
      } else {
        throw new Error(await baleResp.text());
      }
    } catch (e) {
      console.error('Direct send failed:', e);
      await sendTelegramMessage(env, chatId, '❌ Failed to send file to Bale. Trying alternative method...');
      // Fallback to workflow
      await triggerTelegramTransfer(env, baleChatId, fileUrl, fileName);
    }
  } else {
    // Large file – dispatch workflow
    await sendTelegramMessage(env, chatId, '📦 File is large, processing via workflow...');
    await triggerTelegramTransfer(env, baleChatId, fileUrl, fileName);
  }
}

async function getTelegramFile(env: Env, fileId: string): Promise<{ file_path?: string } | null> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const data: any = await resp.json();
  return data?.result;
}

async function sendTelegramMessage(env: Env, chatId: number | string, text: string) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function triggerTelegramTransfer(env: Env, baleChatId: string, fileUrl: string, fileName: string) {
  await triggerWorkflow(env, {
    action: 'telegram_transfer',
    bale_chat_id: baleChatId,
    file_url: fileUrl,
    file_name: fileName,
  }, 'telegram_transfer.yml');
}

function capitalize(s: string) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Import triggerWorkflow from worker.ts (we'll adjust)
import { triggerWorkflow } from './worker';
