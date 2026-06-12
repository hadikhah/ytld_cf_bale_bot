# bot_utils.py
# Reusable utilities for Bale bot workflows

import requests

# ---------- Reusable progress bar ----------
def format_progress_bar(filename, downloaded_bytes, total_bytes, bar_length=10):
    """Returns a Markdown‑formatted progress string like:
       📥 file.mp4  [█████░░░░░] 45% · 25/57 MB
    """
    if total_bytes > 0:
        pct = downloaded_bytes / total_bytes
        filled = int(bar_length * pct)
        bar = "█" * filled + "░" * (bar_length - filled)
        pct_str = f"{pct*100:.0f}%"
        size_dl = f"{downloaded_bytes/(1024*1024):.0f}"
        size_total = f"{total_bytes/(1024*1024):.0f}"
        return f"📥 *{filename}*  [{bar}] {pct_str} · {size_dl}/{size_total} MB"
    else:
        return f"📥 *{filename}*  [{'░'*bar_length}] 0% · 0/? MB"

# ---------- Messaging helpers ----------
class BaleMessenger:
    def __init__(self, token, chat_id):
        self.token = token
        self.chat_id = chat_id

    def api(self, method, payload):
        try:
            resp = requests.post(
                f"https://tapi.bale.ai/bot{self.token}/{method}",
                json=payload, timeout=15
            )
            return resp.json()
        except:
            return None

    def send(self, text, parse_mode="Markdown"):
        print(f"[Bale] {text}")
        return self.api("sendMessage", {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": parse_mode
        })

    def edit(self, msg_id, text, parse_mode="Markdown"):
        if msg_id:
            self.api("editMessageText", {
                "chat_id": self.chat_id,
                "message_id": msg_id,
                "text": text,
                "parse_mode": parse_mode
            })

class TelegramMessenger:
    def __init__(self, token, chat_id):
        self.token = token
        self.chat_id = chat_id

    def api(self, method, payload):
        try:
            resp = requests.post(
                f"https://api.telegram.org/bot{self.token}/{method}",
                json=payload, timeout=15
            )
            return resp.json()
        except:
            return None

    def send(self, text, parse_mode="Markdown"):
        print(f"[Telegram] {text}")
        return self.api("sendMessage", {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": parse_mode
        })

    def edit(self, msg_id, text, parse_mode="Markdown"):
        if msg_id:
            self.api("editMessageText", {
                "chat_id": self.chat_id,
                "message_id": msg_id,
                "text": text,
                "parse_mode": parse_mode
            })

def unlock_queue(worker_url, worker_secret, chat_id):
    if worker_url and worker_secret:
        try:
            requests.post(
                f"{worker_url}/github/done",
                json={"secret": worker_secret, "chat_id": chat_id},
                timeout=5
            )
            print("[Unlock] Queue unlocked")
        except Exception as e:
            print(f"[Unlock] Failed: {e}")
