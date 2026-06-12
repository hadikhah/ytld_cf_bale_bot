import os, subprocess, time, re
from telethon import TelegramClient
from telethon.sessions import StringSession
import requests

API_ID = 2040
API_HASH = "b18441a1ff607e10a989891a5462e627"

session_str = os.environ["TG_USER_SESSION"]
bale_token = os.environ["BALE_BOT_TOKEN"]
bale_chat = os.environ["CHAT_ID"]
channel_id = int(os.environ["CHANNEL_ID"])
message_id = int(os.environ["MESSAGE_ID"])
original_name = os.environ["FILE_NAME"]

MAX_SIZE = 15 * 1024 * 1024

def send_message(text):
    print(f"[Bale] {text}")
    requests.post(f"https://tapi.bale.ai/bot{bale_token}/sendMessage",
                  json={"chat_id": bale_chat, "text": text, "parse_mode": "Markdown"})

def upload_file(path, caption):
    size_mb = os.path.getsize(path) // (1024*1024)
    print(f"[Upload] Sending {os.path.basename(path)} ({size_mb} MB)")
    with open(path, "rb") as f:
        resp = requests.post(f"https://tapi.bale.ai/bot{bale_token}/sendDocument",
                             data={"chat_id": bale_chat, "caption": caption},
                             files={"document": f})
    if resp.ok and resp.json().get("ok"):
        print("[Upload] Success")
        return True
    print(f"[Upload] Failed: {resp.text[:200]}")
    return False

def unlock_queue():
    """Notify the Worker that the download queue can be released."""
    worker_url = os.environ.get("WORKER_URL")
    worker_secret = os.environ.get("WORKER_SECRET")
    if worker_url and worker_secret:
        try:
            requests.post(f"{worker_url}/github/done",
                          json={"secret": worker_secret, "chat_id": bale_chat},
                          timeout=5)
            print("[Unlock] Queue unlocked")
        except Exception as e:
            print(f"[Unlock] Failed: {e}")

async def main():
    # Sanitise the filename – remove any path separators and other dangerous chars
    safe_name = re.sub(r'[\\/*?:"<>|]', "_", original_name)
    # Trim to a reasonable length for the filesystem
    if len(safe_name) > 100:
        safe_name = safe_name[:50] + safe_name[-50:]

    client = TelegramClient(StringSession(session_str), API_ID, API_HASH)
    await client.start()
    try:
        send_message("🔍 Locating your file in the channel…")
        message = await client.get_messages(channel_id, ids=message_id)
        if not message or not message.document:
            send_message("❌ File not found in channel.")
            return

        file_size_mb = message.document.size / (1024 * 1024)
        send_message(f"📥 Downloading *{original_name}* ({file_size_mb:.1f} MB) …")
        print(f"[Download] Starting: {safe_name} ({file_size_mb:.1f} MB)")

        # Download with the sanitised name
        path = await message.download_media(file=safe_name)
        local_size = os.path.getsize(path)
        local_size_mb = local_size / (1024 * 1024)
        print(f"[Download] Finished: {local_size_mb:.1f} MB")

        if local_size <= MAX_SIZE:
            send_message(f"📤 Uploading directly to Bale…")
            if upload_file(path, original_name):
                send_message(f"✅ *{original_name}* sent ({local_size_mb:.1f} MB).")
            else:
                send_message("❌ Upload failed.")
        else:
            send_message(f"📦 Splitting {local_size_mb:.1f} MB file into parts…")
            base = os.path.splitext(safe_name)[0]
            print(f"[Split] Creating multi-part zip from {safe_name}")
            subprocess.run(["zip", "-s", "15m", f"{base}.zip", safe_name], check=True)

            parts = sorted(
                [f for f in os.listdir('.') if f.startswith(base) and (f.endswith('.zip') or '.z' in f)],
                key=lambda x: (not x.endswith('.zip'), x)
            )
            if not parts:
                send_message("❌ Splitting failed – no parts created.")
                return

            total = len(parts)
            send_message(f"📤 Uploading {total} parts…")
            for idx, part in enumerate(parts, 1):
                send_message(f"⬆️ Part {idx}/{total} ({part})")
                if not upload_file(part, part):
                    send_message(f"❌ Failed to upload part {idx}. Aborting.")
                    return
                time.sleep(1)

            ext = os.path.splitext(original_name)[1] or ".file"
            send_message(
                f"✅ *File forwarded successfully!*\n\n"
                f"*How to open your file:*\n"
                f"1. Download all the parts (`.z01`, `.z02`... and `.zip`) into the *same folder*.\n"
                f"2. Open/Extract ONLY the final `.zip` file.\n"
                f"3. Your system will reassemble the full `{ext}` file automatically."
            )
        os.remove(path)
    except Exception as e:
        print(f"[Error] {e}")
        send_message(f"❌ Error: {str(e)[:200]}")
    finally:
        await client.disconnect()
        unlock_queue()

import asyncio
asyncio.run(main())
