import os, subprocess, time, re, tempfile, asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import InputDocumentFileLocation
import requests

API_ID = 2040
API_HASH = "b18441a1ff607e10a989891a5462e627"

session_str = os.environ["TG_USER_SESSION"]
bale_token = os.environ["BALE_BOT_TOKEN"]
bale_chat = os.environ["CHAT_ID"]
tg_token = os.environ["TELEGRAM_BOT_TOKEN"]
tg_chat = os.environ["TG_CHAT_ID"]
channel_id = int(os.environ["CHANNEL_ID"])
message_id = int(os.environ["MESSAGE_ID"])
original_name = os.environ["FILE_NAME"]

MAX_SIZE = 15 * 1024 * 1024

# ---------- Messaging (with fallback) ----------
bale_available = True

def bale_api(method, payload):
    try:
        resp = requests.post(f"https://tapi.bale.ai/bot{bale_token}/{method}", json=payload, timeout=15)
        return resp.json()
    except Exception as e:
        print(f"[Bale] API error: {e}")
        global bale_available
        bale_available = False
        return None

def telegram_api(method, payload):
    try:
        resp = requests.post(f"https://api.telegram.org/bot{tg_token}/{method}", json=payload, timeout=15)
        return resp.json()
    except Exception as e:
        print(f"[Telegram] API error: {e}")
        return None

def send_bale(text):
    if bale_available:
        print(f"[Bale] {text}")
        return bale_api("sendMessage", {"chat_id": bale_chat, "text": text, "parse_mode": "Markdown"})
    return None

def edit_bale(msg_id, text):
    if bale_available and msg_id:
        bale_api("editMessageText", {"chat_id": bale_chat, "message_id": msg_id, "text": text, "parse_mode": "Markdown"})

def send_telegram(text):
    print(f"[Telegram] {text}")
    return telegram_api("sendMessage", {"chat_id": tg_chat, "text": text, "parse_mode": "Markdown"})

def edit_telegram(msg_id, text):
    if msg_id:
        telegram_api("editMessageText", {"chat_id": tg_chat, "message_id": msg_id, "text": text, "parse_mode": "Markdown"})

def upload_file(path, caption):
    if not bale_available:
        print("[Upload] Bale unavailable, skipping upload")
        return False
    size_mb = os.path.getsize(path) // (1024*1024)
    print(f"[Upload] Sending {os.path.basename(path)} ({size_mb} MB)")
    try:
        with open(path, "rb") as f:
            resp = requests.post(f"https://tapi.bale.ai/bot{bale_token}/sendDocument",
                                 data={"chat_id": bale_chat, "caption": caption},
                                 files={"document": f}, timeout=120)
        if resp.ok and resp.json().get("ok"):
            print("[Upload] Success")
            return True
        print(f"[Upload] Failed: {resp.text[:200]}")
        return False
    except Exception as e:
        print(f"[Upload] Error: {e}")
        bale_available = False
        return False

def unlock_queue():
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

# ---------- Network speed test (non‑fatal) ----------
def network_speed_test():
    """Returns the measured speed in MB/s, or 0 on failure."""
    test_url = "https://telegram.org/img/t_logo.png"  # small file
    try:
        start = time.time()
        resp = requests.get(test_url, timeout=15)
        resp.raise_for_status()
        data = resp.content
        elapsed = time.time() - start
        speed = len(data) / elapsed / (1024 * 1024)
        print(f"[SpeedTest] {len(data)//1024} KB in {elapsed:.1f}s ({speed:.1f} MB/s)")
        return speed
    except Exception as e:
        print(f"[SpeedTest] Failed: {e}")
        return 0

# ---------- MTProto download (2 MB chunks) ----------
async def download_large_file(client, msg, file_path, progress_callback):
    doc = msg.document
    location = InputDocumentFileLocation(
        id=doc.id,
        access_hash=doc.access_hash,
        file_reference=doc.file_reference,
        thumb_size=''
    )
    total = doc.size
    part_size = 2 * 1024 * 1024
    with open(file_path, 'wb') as f:
        async for chunk in client.iter_download(location, offset=0, request_size=part_size):
            f.write(chunk)
            progress_callback(len(chunk), total)

# ---------- Main ----------
async def main():
    global bale_available

    safe_name = re.sub(r'[\\/*?:"<>|]', "_", original_name)
    if len(safe_name) > 100:
        safe_name = safe_name[:50] + safe_name[-50:]

    download_dir = tempfile.mkdtemp()
    download_path = os.path.join(download_dir, safe_name)

    # --- Speed test (non‑fatal) ---
    net_speed = network_speed_test()
    if net_speed > 0:
        send_bale(f"🌐 Network baseline: {net_speed:.1f} MB/s")
        send_telegram(f"🌐 Network baseline: {net_speed:.1f} MB/s")
        if net_speed < 1.5:
            send_bale("⚠️ Network is slow – download will take longer.")
            send_telegram("⚠️ Network is slow – download will take longer.")

    client = TelegramClient(
        StringSession(session_str), API_ID, API_HASH,
        connection_retries=5, retry_delay=1, request_retries=5
    )
    await client.start()

    try:
        send_bale("🔍 Locating your file in the channel…")
        send_telegram("🔍 Locating your file in the channel…")

        message = await client.get_messages(channel_id, ids=message_id)
        if not message or not message.document:
            send_bale("❌ File not found in channel.")
            send_telegram("❌ File not found in channel.")
            return

        file_size_mb = message.document.size / (1024 * 1024)

        bale_res = send_bale(f"📥 *{original_name}*\n0% · 0 / {file_size_mb:.1f} MB")
        bale_progress_id = bale_res["result"]["message_id"] if bale_res else None
        tg_res = send_telegram(f"📥 *{original_name}*\n0% · 0 / {file_size_mb:.1f} MB")
        tg_progress_id = tg_res["result"]["message_id"] if tg_res else None

        start = time.time()
        last_update = 0

        def progress_callback(chunk_size, total):
            nonlocal last_update
            progress_callback.downloaded += chunk_size
            now = time.time()
            if total > 0 and now - last_update >= 8:
                pct = progress_callback.downloaded / total * 100
                text = f"📥 *{original_name}*\n{pct:.0f}% · {progress_callback.downloaded//(1024*1024)} / {total//(1024*1024)} MB"
                edit_bale(bale_progress_id, text)
                edit_telegram(tg_progress_id, text)
                last_update = now
        progress_callback.downloaded = 0

        await download_large_file(client, message, download_path, progress_callback)

        elapsed = time.time() - start
        local_size = os.path.getsize(download_path)
        speed_mbps = (local_size / (1024*1024)) / elapsed if elapsed > 0 else 0

        final_dl = f"✅ Downloaded {local_size//(1024*1024)} MB in {elapsed:.0f}s ({speed_mbps:.1f} MB/s). Processing…"
        edit_bale(bale_progress_id, final_dl)
        edit_telegram(tg_progress_id, final_dl)

        # --- Split & upload ---
        if local_size <= MAX_SIZE:
            send_bale("📤 Uploading directly to Bale…")
            send_telegram("📤 Uploading directly to Bale…")
            if bale_available and upload_file(download_path, original_name):
                send_bale(f"✅ *{original_name}* sent.")
                send_telegram(f"✅ *{original_name}* sent.")
            else:
                if not bale_available:
                    send_telegram("⚠️ Bale is currently unreachable. File downloaded but not sent.")
                else:
                    send_bale("❌ Upload failed.")
                    send_telegram("❌ Upload failed.")
        else:
            send_bale(f"📦 Splitting {local_size//(1024*1024)} MB file into parts…")
            send_telegram(f"📦 Splitting {local_size//(1024*1024)} MB file into parts…")
            os.chdir(download_dir)
            base = os.path.splitext(safe_name)[0]
            subprocess.run(["zip", "-s", "15m", f"{base}.zip", safe_name], check=True)

            parts = sorted(
                [f for f in os.listdir(download_dir) if f.startswith(base) and (f.endswith('.zip') or '.z' in f)],
                key=lambda x: (not x.endswith('.zip'), x)
            )
            if not parts:
                send_bale("❌ Splitting failed.")
                send_telegram("❌ Splitting failed.")
                return

            total = len(parts)
            send_bale(f"📤 Uploading {total} parts…")
            send_telegram(f"📤 Uploading {total} parts…")
            all_ok = True
            for idx, part in enumerate(parts, 1):
                send_bale(f"⬆️ Part {idx}/{total} ({part})")
                send_telegram(f"⬆️ Part {idx}/{total} ({part})")
                part_path = os.path.join(download_dir, part)
                if bale_available and not upload_file(part_path, part):
                    send_bale(f"❌ Failed to upload part {idx}. Aborting.")
                    send_telegram(f"❌ Failed to upload part {idx}. Aborting.")
                    all_ok = False
                    break
                time.sleep(1)
            if all_ok:
                ext = os.path.splitext(original_name)[1] or ".file"
                final_msg = (
                    f"✅ *File forwarded successfully!*\n\n"
                    f"*How to open your file:*\n"
                    f"1. Download all the parts (`.z01`, `.z02`... and `.zip`) into the *same folder*.\n"
                    f"2. Open/Extract ONLY the final `.zip` file.\n"
                    f"3. Your system will reassemble the full `{ext}` file automatically."
                )
                send_bale(final_msg)
                send_telegram(final_msg)
    except Exception as e:
        print(f"[Error] {e}")
        send_telegram(f"❌ Error: {str(e)[:200]}")
    finally:
        await client.disconnect()
        import shutil
        shutil.rmtree(download_dir, ignore_errors=True)
        unlock_queue()

asyncio.run(main())
