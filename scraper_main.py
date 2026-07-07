import os
import time
from playwright.sync_api import sync_playwright
from playwright_stealth import stealth_sync

# --- パス設定 ---
EXTENSION_PATH = os.path.abspath(".")
USER_DATA_DIR = os.path.abspath("./chrome_profile")
DOWNLOAD_DIR = os.path.abspath("./downloads")

def run_stealth_scraper():
    # ====================================================
    # 0. 起動時の確認（再開するか、新規か）
    # ====================================================
    print("="*50)
    print("🏥 ナビイ自動スクレイピングシステム")
    print("="*50)
    resume_choice = input("前回の続きから再開しますか？ [y: 続きから / n: 新規スタート]: ")
    
    with sync_playwright() as p:
        chrome_args = [
            f"--disable-extensions-except={EXTENSION_PATH}",
            f"--load-extension={EXTENSION_PATH}",
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--window-size=1920,1080",
        ]

        context = p.chromium.launch_persistent_context(
            user_data_dir=USER_DATA_DIR,
            headless=False,
            args=chrome_args,
            ignore_default_args=["--enable-automation"],
            accept_downloads=True,
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )

        worker = None
        print("拡張機能のシステム起動を待機しています...")
        for _ in range(10):
            if context.service_workers:
                worker = context.service_workers[0]
                break
            time.sleep(1)
        
        if not worker:
            print("エラー: 拡張機能が読み込まれませんでした。")
            context.close()
            return
        
        ext_id = worker.url.split("/")[2]
        ext_page = context.new_page()
        ext_page.goto(f"chrome-extension://{ext_id}/popup.html")
        
        # ユーザーの選択に応じてデータをクリアするか決める
        if resume_choice.lower() != 'y':
            print("🔄 過去のデータをクリアし、新規スタートの準備をします...")
            ext_page.evaluate("() => new Promise(resolve => { chrome.runtime.sendMessage({type: 'NAVII_CLEAR_DATA'}, resolve); })")
        else:
            print("▶️ 前回のデータを保持したまま、続きから再開します。")

        page = context.new_page()
        stealth_sync(page)

        print("ナビイのサイトにアクセスします...")
        page.goto("https://www.iryou.teikyouseido.mhlw.go.jp/")
        page.wait_for_load_state("networkidle")
        
        page.bring_to_front()
        time.sleep(1)

        print("\n" + "="*50)
        print("🌐 ブラウザが開きました。")
        print("1. 画面上で手動で「内視鏡」などの条件で検索を行ってください。")
        print("2. 検索結果の「一覧画面（S2400）」が表示されたことを確認してください。")
        print("3. 確認できたら、このターミナルで Enterキー を押して自動抽出をスタートします。")
        print("="*50 + "\n")
        
        input("準備ができたら Enter を押してください: ")

        # ★取得済みをスキップさせる設定を追加
        safe_settings = {
            "fetchDetailPages": True,
            "skipFetchedFacilities": True,
            "detailConcurrency": 1,
            "listPageDelayMs": 4000,
            "detailPageDelayMs": 3000,
            "randomJitterMinMs": 1500,
            "randomJitterMaxMs": 4500,
            "retryCount": 2
        }

        print("拡張機能にスクレイピング開始 (NAVII_START) を指示します...")
        start_msg = {
            "type": "NAVII_START",
            "settings": safe_settings
        }
        
        start_result = ext_page.evaluate("(msg) => new Promise(resolve => { chrome.runtime.sendMessage(msg, resolve); })", start_msg)
        
        if not start_result or not start_result.get("ok"):
            print(f"開始エラー: {start_result.get('reason')}")
            context.close()
            return

        print("巡回処理を開始しました。進捗を監視します...")
        print("※ 途中で終了してCSVを保存したい場合は [Ctrl + C] を押してください。")

        status = ""
        try:
            while True:
                time.sleep(5)
                state_res = ext_page.evaluate("() => new Promise(resolve => { chrome.runtime.sendMessage({type: 'NAVII_GET_STATE'}, resolve); })")
                
                if state_res and state_res.get("ok"):
                    state = state_res.get("state", {})
                    status = state.get("status")
                    fetched = state.get("fetchedCount", 0)
                    total = state.get("totalCount", 0)
                    page_num = state.get("currentPage", 0)
                    current_name = state.get("currentFacilityName", "なし")
                    
                    print(f"状態: {status} | ページ: {page_num} | 取得件数: {fetched}/{total} | 🏥 処理中: {current_name}")

                    if status in ["完了", "エラー", "アクセス制限検知", "停止済み"]:
                        print(f"巡回ループが終了しました（最終ステータス: {status}）")
                        break
                else:
                    print("状態の取得に失敗しました。再試行します。")
                    
        except KeyboardInterrupt:
            print("\n" + "="*50)
            print("⚠️ ユーザー操作(Ctrl+C)による中断を検知しました。")
            print("現在までに取得したデータをCSVとして保存して終了します...")
            print("="*50)
            
            ext_page.evaluate("() => new Promise(resolve => { chrome.runtime.sendMessage({type: 'NAVII_ABORT'}, resolve); })")
            time.sleep(2) 

        if status != "エラー" and status != "アクセス制限検知":
            print("CSVデータのエクスポートを開始します...")
            with ext_page.expect_download() as download_info:
                export_result = ext_page.evaluate("() => new Promise(resolve => { chrome.runtime.sendMessage({type: 'NAVII_EXPORT_CSV'}, resolve); })")
            
            if export_result and export_result.get("ok"):
                download = download_info.value
                file_path = os.path.join(DOWNLOAD_DIR, download.suggested_filename)
                download.save_as(file_path)
                print(f"🎉 CSVの保存が完了しました: {file_path}")
            else:
                print("CSVの保存に失敗しました。")

        context.close()

if __name__ == "__main__":
    os.makedirs(DOWNLOAD_DIR, exist_ok=True)
    run_stealth_scraper()