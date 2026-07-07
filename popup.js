/**
 * popup.js
 * ---------------------------------------------------------
 * ポップアップUIの操作と、background.js への指示送信、
 * 進捗表示の更新を行う。
 * ---------------------------------------------------------
 */

/* global chrome */
(function () {
  "use strict";

  const el = (id) => document.getElementById(id);

  const messageBox = el("messageBox");

  function showMessage(text) {
    if (!text) {
      messageBox.hidden = true;
      messageBox.textContent = "";
      return;
    }
    messageBox.hidden = false;
    messageBox.textContent = text;
  }

  function sendCommand(type, extra) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(Object.assign({ type }, extra || {}), (response) => {
        resolve(response);
      });
    });
  }

  function renderState(state) {
    if (!state) return;
    el("statusValue").textContent = state.status || "待機中";
    el("currentPage").textContent = state.currentPage || "-";
    el("totalPages").textContent = state.totalPages || "-";
    el("totalCount").textContent = state.totalCount || "-";
    el("fetchedCount").textContent = state.fetchedCount || 0;
    el("duplicateCount").textContent = state.duplicateCount || 0;
    el("errorCount").textContent = state.errorCount || 0;
    el("currentFacilityName").textContent = state.currentFacilityName || "-";
    el("currentDetailUrl").textContent = state.currentDetailUrl || "-";
    el("lastUpdated").textContent = state.lastUpdated
      ? new Date(state.lastUpdated).toLocaleString("ja-JP")
      : "-";
  }

  function renderSettings(settings) {
    if (!settings) return;
    el("maxCount").value = settings.maxCount || "";
    el("listPageDelaySec").value = formatDelaySec(enforceMinDelayMs(settings.listPageDelayMs, 5000), 5000);
    el("detailPageDelaySec").value = formatDelaySec(enforceMinDelayMs(settings.detailPageDelayMs, 5000), 5000);
    el("detailConcurrency").value = settings.detailConcurrency || 1;
    el("resumeFromCurrentPage").checked = settings.resumeFromCurrentPage !== false;
    el("skipFetchedFacilities").checked = settings.skipFetchedFacilities !== false;
    el("fetchDetailPages").checked = settings.fetchDetailPages !== false;
  }

  function parseDelayMs(value, fallbackMs) {
    const parsed = parseFloat(value);
    const delayMs = Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 1000) : fallbackMs;
    return enforceMinDelayMs(delayMs, fallbackMs);
  }

  function enforceMinDelayMs(valueMs, fallbackMs) {
    const ms = Number.isFinite(valueMs) ? valueMs : fallbackMs;
    return Math.max(ms, 3000);
  }

  function formatDelaySec(valueMs, fallbackMs) {
    const ms = Number.isFinite(valueMs) ? valueMs : fallbackMs;
    return String(Math.round((ms / 1000) * 10) / 10);
  }

  function collectSettingsFromForm() {
    const maxCountRaw = el("maxCount").value;
    const detailConcurrency = parseInt(el("detailConcurrency").value, 10);
    return {
      maxCount: maxCountRaw ? parseInt(maxCountRaw, 10) : null,
      listPageDelayMs: parseDelayMs(el("listPageDelaySec").value, 5000),
      detailPageDelayMs: parseDelayMs(el("detailPageDelaySec").value, 5000),
      randomJitterMinMs: 2000,
      randomJitterMaxMs: 6000,
      retryCount: 2,
      detailConcurrency: Number.isFinite(detailConcurrency) ? Math.min(Math.max(detailConcurrency, 1), 2) : 1,
      resumeFromCurrentPage: el("resumeFromCurrentPage").checked,
      skipFetchedFacilities: el("skipFetchedFacilities").checked,
      fetchDetailPages: el("fetchDetailPages").checked
    };
  }

  async function refresh() {
    const res = await sendCommand("NAVII_GET_STATE");
    if (res && res.ok) {
      renderState(res.state);
      renderSettings(res.settings);
    }
  }

  el("btnStart").addEventListener("click", async () => {
    showMessage("");
    const settings = collectSettingsFromForm();
    const res = await sendCommand("NAVII_START", { settings });
    if (!res || !res.ok) {
      showMessage("取得を開始できませんでした。ナビイの検索結果ページを開いているか確認してください。");
    }
    refresh();
  });

  el("btnPause").addEventListener("click", async () => {
    await sendCommand("NAVII_PAUSE");
    refresh();
  });

  el("btnResume").addEventListener("click", async () => {
    await sendCommand("NAVII_RESUME");
    refresh();
  });

  el("btnAbort").addEventListener("click", async () => {
    await sendCommand("NAVII_ABORT");
    refresh();
  });

  el("btnExportCsv").addEventListener("click", async () => {
    const res = await sendCommand("NAVII_EXPORT_CSV");
    if (res && res.ok) {
      showMessage(`CSVを出力しました（${res.count}件）: ${res.filename}`);
    } else {
      showMessage("CSV出力に失敗しました。");
    }
  });

  el("btnExportErrorLog").addEventListener("click", async () => {
    const res = await sendCommand("NAVII_EXPORT_ERROR_LOG");
    if (res && res.ok) {
      showMessage(`エラーログを出力しました（${res.count}件）: ${res.filename}`);
    } else {
      showMessage("エラーログ出力に失敗しました。");
    }
  });

  el("btnExportDebugLog").addEventListener("click", async () => {
    const res = await sendCommand("NAVII_EXPORT_DEBUG_LOG");
    if (res && res.ok) {
      showMessage(`デバッグログを出力しました（${res.count}件）: ${res.filename}`);
    } else {
      showMessage("デバッグログ出力に失敗しました。");
    }
  });

  function renderTestResult(result) {
    const box = el("testResultBox");
    box.hidden = false;

    if (!result || !result.ok) {
      const reason = result ? result.reason : "NO_RESPONSE";
      box.innerHTML = `<div class="trow"><span class="tlabel">解析失敗</span><span class="tvalue">${reason || "不明なエラー"}</span></div>`;
      return;
    }

    const d = result.data || {};
    const debug = result.debug || {};
    const rows = [
      ["正式名称", d.officialName || "(空欄)"],
      ["名称カナ", d.nameKana || "(空欄)"],
      ["機関区分", d.facilityType || "(空欄)"],
      ["郵便番号", d.postalCode || "(空欄)"],
      ["住所", [d.prefecture, d.addr1, d.addr2].filter(Boolean).join(" ") || "(空欄)"],
      ["電話番号(Tel1)", d.tel1 || "(空欄)"],
      ["FAX", d.fax || "(空欄)"],
      ["URL", d.url || "(空欄)"],
      ["診療日", (d.clinicDays || []).join(",") || "(空欄)"],
      ["休診日", (d.closedDays || []).join(",") || "(空欄)"],
      ["午前時間", d.amStart && d.amEnd ? `${d.amStart}-${d.amEnd}` : "(空欄)"],
      ["午後時間", d.pmStart && d.pmEnd ? `${d.pmStart}-${d.pmEnd}` : "(空欄)"],
      ["---検出情報---", ""],
      ["使用した名前ソース", debug.usedNameSource || "-"],
      ["診療時間タブの有無", debug.scheduleTabFound ? "あり" : "なし"],
      ["診療時間タブを開けたか", debug.scheduleTabOpened ? "開けた" : "未使用/開けず"],
      ["検出した曜日数", debug.detectedWeekdayCount || 0],
      ["検出した時間帯数", debug.detectedSlotCount || 0],
      ["解析エラー", (debug.parseErrors || []).join(" / ") || "なし"]
    ];

    box.innerHTML = rows
      .map(
        ([label, value]) =>
          `<div class="trow"><span class="tlabel">${label}</span><span class="tvalue">${String(value)}</span></div>`
      )
      .join("");
  }

  el("btnTestCurrentPage").addEventListener("click", async () => {
    showMessage("");
    el("testResultBox").hidden = false;
    el("testResultBox").textContent = "解析中...";
    const res = await sendCommand("NAVII_TEST_CURRENT_PAGE");
    renderTestResult(res);
  });

  el("btnClearData").addEventListener("click", async () => {
    const confirmed = confirm("取得済みデータをすべて消去します。よろしいですか？");
    if (!confirmed) return;
    await sendCommand("NAVII_CLEAR_DATA");
    showMessage("取得済みデータを消去しました。");
    refresh();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "NAVII_STATE_UPDATED") {
      renderState(message.state);
    }
  });

  document.addEventListener("DOMContentLoaded", refresh);
  refresh();
  setInterval(refresh, 2000);
})();
