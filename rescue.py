import os
import time
from playwright.sync_api import sync_playwright

EXTENSION_PATH = os.path.abspath(".")
USER_DATA_DIR = os.path.abspath("./chrome_profile")
DOWNLOAD_DIR = os.path.abspath("./downloads")

def rescue_data():
    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            headless=False,
            args=[
                f"--disable-extensions-except={EXTENSION_PATH}",
                f"--load-extension={EXTENSION_PATH}"
            ],
            accept_downloads=True
        )

        worker = None
        for _ in range(10):
            if context.service_workers:
                worker = context.service_workers[0]
                break
            time.sleep(1)
        
        if not worker:
            print("エラー: 拡張機能に接続できませんでした。")
            context.close()
            return
            
        ext_id = worker.url.split("/")[2]
        ext_page = context.new_page()
        ext_page.goto(f"chrome-extension://{ext_id}/popup.html")

        print("🚑 拡張機能の中に残っているデータを救出しています...")
        
        try:
            with ext_page.expect_download(timeout=10000) as download_info:
                ext_page.evaluate("() => new Promise(resolve => { chrome.runtime.sendMessage({type: 'NAVII_EXPORT_CSV'}, resolve); })")
            
            download = download_info.value
            file_path = os.path.join(DOWNLOAD_DIR, "rescued_data.csv")
            download.save_as(file_path)
            
            print(f"🎉 レスキュー大成功！CSVを保存しました: {file_path}")
        
        except Exception as e:
            print(f"データの救出に失敗したか、保存されているデータがありませんでした: {e}")

        context.close()

if __name__ == "__main__":
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    rescue_data()