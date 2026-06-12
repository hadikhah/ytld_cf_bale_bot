import os, subprocess, time
from telethon import TelegramClient
from telethon.sessions import StringSession
import requests

# Official Telegram API credentials (public)
API_ID = 2040
API_HASH = "b18441a1ff607e10a989891a5462e627"

session_str = os.environ["TG_USER_SESSION"]
bale_token = os.environ["BALE_BOT_TOKEN"]
bale_chat = os.environ["CHAT_ID"]
channel_id = int(os.environ["CHANNEL_ID"])
message_id = int(os.environ["MESSAGE_ID"])
file_name = os.environ["FILE_NAME"]

MAX_SIZE = 15 * 1024 * 1024  # 15 MB per part

def send_message(text):
    requests.post(f"https://tapi.bale.ai/bot{bale_token}/sendMessage",
                  json={"chat_id": bale_chat, "text": text})

def upload_file(path, caption):
    with open(path, "rb") as f:
        requests.post(f"https://tapi.bale.ai/bot{bale_token}/sendDocument",
                      data={"chat_id": bale_chat, "caption": caption},
                      files={"document": f})

async def main():
    # Create client directly with the StringSession
    client = TelegramClient(StringSession(session_str), API_ID, API_HASH)
    await client.start()  # Will use the existing session string, no phone needed
    try:
        message = await client.get_messages(channel_id, ids=message_id)
        if not message or not message.document:
            send_message("❌ File not found in channel.")
            return

        path = await message.download_media(file=file_name)
        file_size = os.path.getsize(path)

        if file_size <= MAX_SIZE:
            upload_file(path, file_name)
            send_message("✅ Large file forwarded from Telegram.")
        else:
            send_message("⚠️ File too large, splitting…")
            base = os.path.splitext(file_name)[0]
            subprocess.run(["zip", "-s", "15m", f"{base}.zip", file_name], check=True)
            parts = sorted(
                [f for f in os.listdir('.') if f.startswith(base) and (f.endswith('.zip') or '.z' in f)],
                key=lambda x: (not x.endswith('.zip'), x)
            )
            for part in parts:
                upload_file(part, part)
                time.sleep(1)
            send_message("✅ Large file forwarded (extract all parts and open the .zip).")
        os.remove(path)
    finally:
        await client.disconnect()

import asyncio
asyncio.run(main())
