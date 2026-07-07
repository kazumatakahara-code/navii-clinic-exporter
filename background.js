/**
 * background.js (service worker)
 * ---------------------------------------------------------
 * ・popupからのコマンドを受け取り、状態管理と巡回処理を行う
 * ・検索結果ページのタブは維持し、詳細ページはバックグラウンドタブで
 *   1件ずつ開いて閉じる
 * ・chrome.storage.local に進捗を保存し、service workerが
 *   停止・再起動しても再開できるようにする
 * ---------------------------------------------------------
 */

/* global chrome, importScripts, NaviiConfig, NaviiUtils */
importScripts("config.js", "utils.js", "sjis-table.js");

const CFG = self.NaviiConfig;
const UTIL = self.NaviiUtils;

const STORAGE_KEYS = {
  SETTINGS: "naviiSettings",
  STATE: "naviiState",
  FACILITIES: "naviiFacilities",
  PROCESSED_URLS: "naviiProcessedDetailUrls",
  PROCESSED_CODES: "naviiProcessedCodes",
  FINGERPRINTS: "naviiPageFingerprints",
  ERROR_LOG: "naviiErrorLog",
  DEBUG_LOG: "naviiDebugLog"
};

const STATUS = {
  IDLE: "待機中",
  RUNNING: "取得中",
  PAUSED: "一時停止",
  STOPPED: "停止済み",
  DONE: "完了",
  ERROR: "エラー",
  BLOCKED: "アクセス制限検知"
};

// 実行中フラグ（service worker内メモリ。永続化はstorageで別途行う）
let isLoopRunning = false;
let pauseRequested = false;
let abortRequested = false;

// ---------------------------------------------------------
// storageヘルパー
// ---------------------------------------------------------

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

async function getSettings() {
  const res = await storageGet(STORAGE_KEYS.SETTINGS);
  return Object.assign({}, CFG.defaults, res[STORAGE_KEYS.SETTINGS] || {});
}

async function getState() {
  const res = await storageGet(STORAGE_KEYS.STATE);
  return (
    res[STORAGE_KEYS.STATE] || {
      status: STATUS.IDLE,
      currentPage: 0,
      totalPages: 0,
      totalCount: 0,
      fetchedCount: 0,
      duplicateCount: 0,
      errorCount: 0,
      currentFacilityName: "",
      currentDetailUrl: "",
      lastUpdated: "",
      startedAt: "",
      startUrl: "",
      searchTabId: null
    }
  );
}

async function setState(partial) {
  const current = await getState();
  const next = Object.assign({}, current, partial, {
    lastUpdated: new Date().toISOString()
  });
  await storageSet({ [STORAGE_KEYS.STATE]: next });
  // popupが開いていれば通知（開いていなければエラーになるが無視してよい）
  chrome.runtime.sendMessage({ type: "NAVII_STATE_UPDATED", state: next }).catch(() => {});
  return next;
}

async function getFacilities() {
  const res = await storageGet(STORAGE_KEYS.FACILITIES);
  return res[STORAGE_KEYS.FACILITIES] || [];
}
async function setFacilities(list) {
  await storageSet({ [STORAGE_KEYS.FACILITIES]: list });
}

async function getProcessedSets() {
  const res = await storageGet([STORAGE_KEYS.PROCESSED_URLS, STORAGE_KEYS.PROCESSED_CODES]);
  return {
    urls: new Set(res[STORAGE_KEYS.PROCESSED_URLS] || []),
    codes: new Set(res[STORAGE_KEYS.PROCESSED_CODES] || [])
  };
}
async function saveProcessedSets(urls, codes) {
  await storageSet({
    [STORAGE_KEYS.PROCESSED_URLS]: Array.from(urls),
    [STORAGE_KEYS.PROCESSED_CODES]: Array.from(codes)
  });
}

async function appendErrorLog(entry) {
  const res = await storageGet(STORAGE_KEYS.ERROR_LOG);
  const log = res[STORAGE_KEYS.ERROR_LOG] || [];
  log.push(entry);
  await storageSet({ [STORAGE_KEYS.ERROR_LOG]: log });
}

async function appendDebugLog(entry) {
  const res = await storageGet(STORAGE_KEYS.DEBUG_LOG);
  const log = res[STORAGE_KEYS.DEBUG_LOG] || [];
  log.push(entry);
  await storageSet({ [STORAGE_KEYS.DEBUG_LOG]: log });
}

async function clearAllData() {
  await storageSet({
    [STORAGE_KEYS.FACILITIES]: [],
    [STORAGE_KEYS.PROCESSED_URLS]: [],
    [STORAGE_KEYS.PROCESSED_CODES]: [],
    [STORAGE_KEYS.FINGERPRINTS]: [],
    [STORAGE_KEYS.ERROR_LOG]: [],
    [STORAGE_KEYS.DEBUG_LOG]: []
  });
  await setState({
    status: STATUS.IDLE,
    currentPage: 0,
    totalPages: 0,
    totalCount: 0,
    fetchedCount: 0,
    duplicateCount: 0,
    errorCount: 0,
    currentFacilityName: "",
    currentDetailUrl: "",
    startedAt: "",
    startUrl: "",
    searchTabId: null
  });
}

// ---------------------------------------------------------
// タブ・メッセージ ヘルパー
// ---------------------------------------------------------

function sendMessageToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, reason: "NO_RESPONSE", error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs || 15000);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        if (done) return;
        done = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForListPageChange(searchTabId, previousFingerprint, previousPage, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 15000);

  while (Date.now() < deadline) {
    await sleep(500);
    const response = await sendMessageToTab(searchTabId, { type: "NAVII_EXTRACT_LIST" });
    if (!response || !response.ok) continue;

    const pageChanged = previousPage && response.currentPage && response.currentPage !== previousPage;
    const fingerprintChanged = response.fingerprint && response.fingerprint !== previousFingerprint;
    if (pageChanged || fingerprintChanged) {
      return { ok: true, page: response };
    }
  }

  return { ok: false, reason: "NO_PAGE_CHANGE" };
}

function randomJitter(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function settingDelayMs(value, fallbackMs) {
  const delayMs = Number.isFinite(value) && value >= 0 ? value : fallbackMs;
  return Math.max(delayMs, 3000);
}

function getDetailConcurrency(settings) {
  const value = parseInt(settings.detailConcurrency, 10);
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 1), 2);
}

async function openDetailTabAndExtract(detailUrl, settings, searchResultName) {
  const tab = await new Promise((resolve) => {
    chrome.tabs.create({ url: detailUrl, active: false }, resolve);
  });
  try {
    const loaded = await waitForTabComplete(tab.id, 20000);
    if (!loaded) {
      return { ok: false, reason: "LOAD_TIMEOUT" };
    }
    // ページ内スクリプトの初期化猶予
    await sleep(300);
    const response = await sendMessageToTab(tab.id, {
      type: "NAVII_EXTRACT_DETAIL",
      searchResultName: searchResultName || ""
    });
    return response || { ok: false, reason: "NO_RESPONSE" };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function fetchDetailForFacility(facility, settings) {
  let detailData = null;
  let detailDebug = null;
  let blockedDetected = false;
  let detailFailed = false;

  if (settings.fetchDetailPages && facility.detailUrl) {
    let attempt = 0;
    while (attempt <= settings.retryCount) {
      const result = await openDetailTabAndExtract(facility.detailUrl, settings, facility.name);
      if (result && result.ok) {
        detailData = result.data;
        detailDebug = result.debug || null;
        break;
      }
      if (result && result.reason === "BLOCKED") {
        blockedDetected = true;
        break;
      }
      attempt++;
      if (attempt <= settings.retryCount) {
        await sleep(randomJitter(settings.randomJitterMinMs, settings.randomJitterMaxMs));
      }
    }
    detailFailed = !detailData && !blockedDetected;
  }

  return { facility, detailData, detailDebug, blockedDetected, detailFailed };
}

// ---------------------------------------------------------
// 一時停止・中止のチェック（メインループ内で都度呼ぶ）
// ---------------------------------------------------------

async function waitWhilePaused() {
  while (pauseRequested && !abortRequested) {
    await sleep(500);
  }
}

// ---------------------------------------------------------
// レコード変換（content.js からの抽出結果 → CSV用フィールド）
// ---------------------------------------------------------

function buildRecordFromListAndDetail(listItem, detailData) {
  const merged = Object.assign({}, listItem, detailData || {});
  // 最終的な名前の決定: officialNameがあればofficialName、なければ検索結果一覧の名前
  const finalName = (detailData && detailData.officialName) || listItem.name || "";
  return {
    facilityCode: merged.facilityCode || "",
    detailUrl: merged.detailUrl || listItem.detailUrl || "",
    type: merged.facilityType || "",
    name: finalName,
    kana: (detailData && detailData.nameKana) || "",
    postalCode: merged.postalCode || "",
    prefecture: merged.prefecture || "",
    addr1: merged.addr1 || "",
    addr2: merged.addr2 || "",
    addressKana: merged.addressKana || "",
    tel1: merged.tel1 || "",
    tel2: merged.tel2 || "",
    tel3: merged.tel3 || "",
    tel4: merged.tel4 || "",
    fax: merged.fax || "",
    url: merged.url || "",
    remarks: merged.remarks || "",
    closedDays: (merged.closedDays || []).join(","),
    clinicDays: (merged.clinicDays || []).join(","),
    amStart: merged.amStart || "",
    amEnd: merged.amEnd || "",
    pmStart: merged.pmStart || "",
    pmEnd: merged.pmEnd || "",
    director: merged.director || "",
    openedDate: merged.openedDate || ""
  };
}

async function addOrMergeFacility(record) {
  const facilities = await getFacilities();
  let mergedIndex = -1;

  for (let i = 0; i < facilities.length; i++) {
    if (UTIL.isDuplicateFacility(facilities[i], record)) {
      mergedIndex = i;
      break;
    }
  }

  if (mergedIndex === -1) {
    facilities.push(record);
    await setFacilities(facilities);
    return { duplicated: false };
  }

  const { merged, conflicts } = UTIL.mergeFacilityRecords(facilities[mergedIndex], record);
  facilities[mergedIndex] = merged;
  await setFacilities(facilities);

  if (conflicts.length) {
    await appendErrorLog({
      date: new Date().toISOString(),
      name: record.name,
      detailUrl: record.detailUrl,
      page: "",
      stage: "重複統合",
      message: `差異あり: ${conflicts.join(" / ")}`,
      retryCount: 0
    });
  }
  return { duplicated: true };
}

// ---------------------------------------------------------
// メイン巡回処理
// ---------------------------------------------------------

async function runScrapeLoop(searchTabId, startFromCurrentPage) {
  if (isLoopRunning) return;
  isLoopRunning = true;
  pauseRequested = false;
  abortRequested = false;

  const settings = await getSettings();
  let { urls: processedUrls, codes: processedCodes } = await getProcessedSets();
  let lastFingerprint = null;

  await setState({
    status: STATUS.RUNNING,
    startedAt: new Date().toISOString(),
    searchTabId
  });

  try {
    const readiness = await sendMessageToTab(searchTabId, { type: "NAVII_CHECK_READY" });
    if (!readiness || !readiness.ok) {
      const reasonMap = {
        NOT_TARGET_PAGE:
          "ナビイのキーワード検索結果ページを開いてから、取得開始を押してください。\n検索ワードを入力して検索を実行し、施設一覧が表示された状態で使用してください。",
        NO_LIST_FOUND:
          "ナビイのキーワード検索結果ページを開いてから、取得開始を押してください。\n検索ワードを入力して検索を実行し、施設一覧が表示された状態で使用してください。",
        ZERO_RESULTS:
          "現在の検索条件では医療機関が見つかりません。\nナビイ上で検索条件を変更してから再度実行してください。",
        NO_DETAIL_LINK:
          "ナビイのキーワード検索結果ページを開いてから、取得開始を押してください。\n検索ワードを入力して検索を実行し、施設一覧が表示された状態で使用してください。",
        BLOCKED: "アクセス制限を検知したため処理を開始できません。"
      };
      const reason = readiness ? readiness.reason : "NO_RESPONSE";
      await setState({
        status: reason === "BLOCKED" ? STATUS.BLOCKED : STATUS.ERROR
      });
      await appendErrorLog({
        date: new Date().toISOString(),
        name: "",
        detailUrl: "",
        page: "",
        stage: "開始前チェック",
        message: reasonMap[reason] || `開始条件を満たしていません (${reason})`,
        retryCount: 0
      });
      return;
    }

    let pageCount = 0;
    let fetchedTotal = (await getState()).fetchedCount || 0;

    while (true) {
      if (abortRequested) break;
      await waitWhilePaused();
      if (abortRequested) break;

      const listResponse = await sendMessageToTab(searchTabId, { type: "NAVII_EXTRACT_LIST" });
      if (!listResponse || !listResponse.ok) {
        await appendErrorLog({
          date: new Date().toISOString(),
          name: "",
          detailUrl: "",
          page: String(pageCount + 1),
          stage: "一覧取得",
          message: "検索結果一覧の取得に失敗しました",
          retryCount: 0
        });
        await setState({ status: STATUS.ERROR });
        break;
      }

      const { facilities, totalCount, currentPage, totalPages, fingerprint } = listResponse;

      if (fingerprint && fingerprint === lastFingerprint) {
        await appendErrorLog({
          date: new Date().toISOString(),
          name: "",
          detailUrl: "",
          page: String(currentPage || pageCount + 1),
          stage: "ページ巡回",
          message: "同じページ指紋が連続したため処理を停止しました",
          retryCount: 0
        });
        await setState({ status: STATUS.ERROR });
        break;
      }
      lastFingerprint = fingerprint;

      await setState({
        currentPage: currentPage || pageCount + 1,
        totalPages: totalPages || 0,
        totalCount: totalCount || 0
      });

      const detailConcurrency = settings.fetchDetailPages ? getDetailConcurrency(settings) : 1;
      let facilityIndex = 0;
      while (facilityIndex < facilities.length) {
        if (abortRequested) break;
        await waitWhilePaused();
        if (abortRequested) break;

        const batch = [];
        while (facilityIndex < facilities.length && batch.length < detailConcurrency) {
          if (settings.maxCount && fetchedTotal + batch.length >= settings.maxCount) break;

          const facility = facilities[facilityIndex];
          facilityIndex++;

          const alreadyDone =
            settings.skipFetchedFacilities &&
            ((facility.detailUrl && processedUrls.has(facility.detailUrl)) ||
              (facility.facilityCode && processedCodes.has(facility.facilityCode)));
          if (alreadyDone) continue;

          batch.push(facility);
        }

        if (!batch.length) break;

        await setState({
          currentFacilityName: batch.map((facility) => facility.name).filter(Boolean).join(" / "),
          currentDetailUrl: batch.map((facility) => facility.detailUrl).filter(Boolean).join(" / ")
        });

        const batchResults = settings.fetchDetailPages
          ? await Promise.all(batch.map((facility) => fetchDetailForFacility(facility, settings)))
          : batch.map((facility) => ({
              facility,
              detailData: null,
              detailDebug: null,
              blockedDetected: false,
              detailFailed: false
            }));

        for (const result of batchResults) {
          const { facility, detailData, detailDebug, blockedDetected, detailFailed } = result;

          if (blockedDetected) {
            await setState({ status: STATUS.BLOCKED });
            abortRequested = true;
            break;
          }

          if (detailFailed) {
            await appendErrorLog({
              date: new Date().toISOString(),
              name: facility.name,
              detailUrl: facility.detailUrl,
              page: String(currentPage || pageCount + 1),
              stage: "詳細取得",
              message: "詳細ページの取得に失敗しました",
              retryCount: settings.retryCount
            });
            const st = await getState();
            await setState({ errorCount: (st.errorCount || 0) + 1 });
          }

          if (detailDebug) {
            await appendDebugLog({
              detailUrl: detailDebug.detailUrl || facility.detailUrl,
              searchResultName: detailDebug.searchResultName || facility.name,
              officialNameCandidate: detailDebug.officialNameCandidate || "",
              kanaCandidate: detailDebug.kanaCandidate || "",
              usedNameSource: detailDebug.usedNameSource || "",
              usedKanaLabel: detailDebug.usedKanaLabel || "",
              detectedFacilityType: detailDebug.detectedFacilityType || "",
              scheduleTabFound: detailDebug.scheduleTabFound ? "あり" : "なし",
              scheduleTabOpened: detailDebug.scheduleTabOpened ? "開けた" : "未使用/開けず",
              detectedWeekdayCount: detailDebug.detectedWeekdayCount || 0,
              detectedSlotCount: detailDebug.detectedSlotCount || 0,
              detectedClosedDays: (detailDebug.detectedClosedDays || []).join(","),
              detectedExternalUrl: detailDebug.detectedExternalUrl || "",
              parseErrors: (detailDebug.parseErrors || []).join(" / ")
            });
          }

          const record = buildRecordFromListAndDetail(facility, detailData);
          const mergeResult = await addOrMergeFacility(record);

          if (facility.detailUrl) processedUrls.add(facility.detailUrl);
          if (facility.facilityCode) processedCodes.add(facility.facilityCode);
          await saveProcessedSets(processedUrls, processedCodes);

          fetchedTotal++;
          const stNow = await getState();
          await setState({
            fetchedCount: fetchedTotal,
            duplicateCount: mergeResult.duplicated
              ? (stNow.duplicateCount || 0) + 1
              : stNow.duplicateCount || 0
          });
        }

        if (abortRequested) break;

        if (settings.fetchDetailPages && batch.some((facility) => facility.detailUrl)) {
          await sleep(
            settingDelayMs(settings.detailPageDelayMs, 5000) +
              randomJitter(settings.randomJitterMinMs, settings.randomJitterMaxMs)
          );
        }
      }

      if (abortRequested) break;
      if (settings.maxCount && fetchedTotal >= settings.maxCount) {
        await setState({ status: STATUS.DONE });
        break;
      }

      // アクセス制限チェック
      const blockedCheck = await sendMessageToTab(searchTabId, { type: "NAVII_CHECK_BLOCKED" });
      if (blockedCheck && blockedCheck.blocked) {
        await setState({ status: STATUS.BLOCKED });
        break;
      }

      await sleep(
        settingDelayMs(settings.listPageDelayMs, 5000) +
          randomJitter(settings.randomJitterMinMs, settings.randomJitterMaxMs)
      );

      const nextResult = await sendMessageToTab(searchTabId, {
        type: "NAVII_NEXT_PAGE",
        previousFingerprint: fingerprint,
        previousPage: currentPage || pageCount + 1,
        timeoutMs: 15000
      });

      let pageMoved = Boolean(nextResult && nextResult.ok);
      if (!pageMoved && (!nextResult || nextResult.reason !== "NO_NEXT_BUTTON")) {
        const fallbackResult = await waitForListPageChange(
          searchTabId,
          fingerprint,
          currentPage || pageCount + 1,
          10000
        );
        pageMoved = Boolean(fallbackResult && fallbackResult.ok);
      }

      if (!pageMoved) {
        // 次ページが無い＝最終ページまで完了
        await setState({ status: STATUS.DONE });
        break;
      }

      pageCount++;
    }
  } catch (e) {
    await appendErrorLog({
      date: new Date().toISOString(),
      name: "",
      detailUrl: "",
      page: "",
      stage: "全体処理",
      message: String(e && e.message ? e.message : e),
      retryCount: 0
    });
    await setState({ status: STATUS.ERROR });
  } finally {
    isLoopRunning = false;
    const finalState = await getState();
    if (finalState.status === STATUS.RUNNING) {
      await setState({ status: abortRequested ? STATUS.STOPPED : STATUS.DONE });
    }
  }
}

// ---------------------------------------------------------
// CSV / エラーログ出力
// ---------------------------------------------------------

function formatTimestampForFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(
    d.getMinutes()
  )}`;
}

function recordToCsvRow(record) {
  const values = [
    "", // UUID
    record.type || "",
    record.name || "",
    record.kana || "",
    record.postalCode || "",
    record.prefecture || "",
    record.addr1 || "",
    record.addr2 || "",
    record.addressKana || "",
    record.tel1 || "",
    record.tel2 || "",
    record.tel3 || "",
    record.tel4 || "",
    record.fax || "",
    record.url || "",
    record.remarks || "",
    "", // 旧社名
    "ナビイ", // リードソース
    "", // 履歴
    "", // 記事名
    record.closedDays || "",
    record.clinicDays || "",
    record.amStart || "",
    record.amEnd || "",
    record.pmStart || "",
    record.pmEnd || "",
    record.director || "",
    record.openedDate || ""
  ];
  return UTIL.validateAndPadRow(values, CFG.csvColumns.length);
}

async function exportFacilitiesCsv() {
  const facilities = await getFacilities();
  const header = CFG.csvColumns;
  const lines = [UTIL.buildCsvRow(header)];
  for (const f of facilities) {
    lines.push(UTIL.buildCsvRow(recordToCsvRow(f)));
  }
  const csvContent = lines.join("\r\n") + "\r\n";
  const filename = `navii_clinics_call_system_${formatTimestampForFilename()}.csv`;
  await downloadCsvAsShiftJIS(csvContent, filename);
  return { ok: true, filename, count: facilities.length };
}

async function exportErrorLogCsv() {
  const res = await storageGet(STORAGE_KEYS.ERROR_LOG);
  const log = res[STORAGE_KEYS.ERROR_LOG] || [];
  const header = CFG.errorCsvColumns;
  const lines = [UTIL.buildCsvRow(header)];
  for (const e of log) {
    lines.push(
      UTIL.buildCsvRow([
        e.date || "",
        e.name || "",
        e.detailUrl || "",
        e.page || "",
        e.stage || "",
        e.message || "",
        String(e.retryCount || 0)
      ])
    );
  }
  const csvContent = lines.join("\r\n") + "\r\n";
  const filename = `navii_clinics_errors_${formatTimestampForFilename()}.csv`;
  await downloadCsvAsShiftJIS(csvContent, filename);
  return { ok: true, filename, count: log.length };
}

async function exportDebugLogCsv() {
  const res = await storageGet(STORAGE_KEYS.DEBUG_LOG);
  const log = res[STORAGE_KEYS.DEBUG_LOG] || [];
  const header = CFG.debugCsvColumns;
  const lines = [UTIL.buildCsvRow(header)];
  for (const d of log) {
    lines.push(
      UTIL.buildCsvRow([
        d.detailUrl || "",
        d.searchResultName || "",
        d.officialNameCandidate || "",
        d.kanaCandidate || "",
        d.usedNameSource || "",
        d.usedKanaLabel || "",
        d.detectedFacilityType || "",
        d.scheduleTabFound || "",
        d.scheduleTabOpened || "",
        String(d.detectedWeekdayCount || 0),
        String(d.detectedSlotCount || 0),
        d.detectedClosedDays || "",
        d.detectedExternalUrl || "",
        d.parseErrors || ""
      ])
    );
  }
  const csvContent = lines.join("\r\n") + "\r\n";
  const filename = `navii_clinics_debug_${formatTimestampForFilename()}.csv`;
  await downloadCsvAsShiftJIS(csvContent, filename);
  return { ok: true, filename, count: log.length };
}

/**
 * CSVテキストをShift-JIS(Windows-31J/CP932相当)のバイト列へ変換してダウンロードする。
 * ダブルクリックでExcelを開いた際に文字コード判定ミスで文字化けするのを防ぐため、
 * UTF-8+BOMではなく、日本語版Windows Excelの既定文字コードであるShift-JISで出力する。
 * 変換表に無い文字（絵文字等）は "?" に置き換えられる。
 */
async function downloadCsvAsShiftJIS(csvText, filename) {
  const bytes = UTIL.encodeShiftJIS(csvText);
  const base64 = base64EncodeBytes(bytes);
  const dataUrl = "data:text/csv;charset=shift_jis;base64," + base64;
  return new Promise((resolve) => {
    chrome.downloads.download({ url: dataUrl, filename, saveAs: false }, (downloadId) => {
      resolve(downloadId);
    });
  });
}

function base64EncodeBytes(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
}

// ---------------------------------------------------------
// popupからのメッセージ処理
// ---------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  (async () => {
    switch (message.type) {
      case "NAVII_START": {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) {
          sendResponse({ ok: false, reason: "NO_ACTIVE_TAB" });
          return;
        }
        if (message.settings) {
          await storageSet({ [STORAGE_KEYS.SETTINGS]: message.settings });
        }
        runScrapeLoop(activeTab.id, true);
        sendResponse({ ok: true });
        break;
      }
      case "NAVII_PAUSE":
        pauseRequested = true;
        await setState({ status: STATUS.PAUSED });
        sendResponse({ ok: true });
        break;
      case "NAVII_RESUME": {
        pauseRequested = false;
        const st = await getState();
        if (!isLoopRunning && st.searchTabId) {
          await setState({ status: STATUS.RUNNING });
          runScrapeLoop(st.searchTabId, true);
        } else {
          await setState({ status: STATUS.RUNNING });
        }
        sendResponse({ ok: true });
        break;
      }
      case "NAVII_ABORT":
        abortRequested = true;
        pauseRequested = false;
        await setState({ status: STATUS.STOPPED });
        sendResponse({ ok: true });
        break;
      case "NAVII_EXPORT_CSV": {
        const result = await exportFacilitiesCsv();
        sendResponse(result);
        break;
      }
      case "NAVII_EXPORT_ERROR_LOG": {
        const result = await exportErrorLogCsv();
        sendResponse(result);
        break;
      }
      case "NAVII_EXPORT_DEBUG_LOG": {
        const result = await exportDebugLogCsv();
        sendResponse(result);
        break;
      }
      case "NAVII_TEST_CURRENT_PAGE": {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) {
          sendResponse({ ok: false, reason: "NO_ACTIVE_TAB" });
          break;
        }
        const result = await sendMessageToTab(activeTab.id, {
          type: "NAVII_TEST_CURRENT_PAGE",
          searchResultName: ""
        });
        sendResponse(result || { ok: false, reason: "NO_RESPONSE" });
        break;
      }
      case "NAVII_CLEAR_DATA":
        await clearAllData();
        sendResponse({ ok: true });
        break;
      case "NAVII_GET_STATE": {
        const state = await getState();
        const settings = await getSettings();
        sendResponse({ ok: true, state, settings });
        break;
      }
      default:
        sendResponse({ ok: false, reason: "UNKNOWN_MESSAGE" });
    }
  })();

  return true; // 非同期応答を許可
});

// service worker 再起動時に「取得中」のまま残っている状態を「一時停止」に補正する
chrome.runtime.onStartup.addListener(async () => {
  const st = await getState();
  if (st.status === STATUS.RUNNING) {
    await setState({ status: STATUS.PAUSED });
  }
});
chrome.runtime.onInstalled.addListener(async () => {
  const st = await getState();
  if (st.status === STATUS.RUNNING) {
    await setState({ status: STATUS.PAUSED });
  }
});
