/**
 * content.js
 * ---------------------------------------------------------
 * ナビイのページ（S2400検索結果ページ、および施設詳細ページ）に
 * 注入され、background.js からのメッセージに応じてDOMを解析する。
 * クラス名だけに依存せず、見出し・ラベル・属性・近接要素などを
 * 組み合わせて解析する。
 * ---------------------------------------------------------
 */

/* global chrome, NaviiConfig, NaviiUtils, MutationObserver */
(function () {
  "use strict";

  const CFG = window.NaviiConfig;
  const UTIL = window.NaviiUtils;

  // ---------------------------------------------------------
  // 共通DOMヘルパー
  // ---------------------------------------------------------

  function queryFirst(root, selectors) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* 無効なセレクタは無視 */
      }
    }
    return null;
  }

  function queryAllFirstMatch(root, selectors) {
    for (const sel of selectors) {
      try {
        const els = root.querySelectorAll(sel);
        if (els && els.length) return Array.from(els);
      } catch (e) {
        /* 無効なセレクタは無視 */
      }
    }
    return [];
  }

  function getText(el) {
    if (!el) return "";
    // ruby注釈（<rt>/<rp>）が含まれる場合、読み仮名が本文と混ざらないよう除去する
    if (typeof el.querySelectorAll === "function" && el.querySelectorAll("rt, rp").length) {
      const clone = el.cloneNode(true);
      clone.querySelectorAll("rt, rp").forEach((n) => n.remove());
      return UTIL.safeStr(clone.textContent);
    }
    return UTIL.safeStr(el.textContent);
  }

  /**
   * 単一のラベル候補（1つの表記のみ）に対して、値を1つ探す内部関数。
   * table(th+td) / dl(dt+dd) / ラベル+次の兄弟 / ラベル+同一親内の値、を試す。
   */
  function findValueForSingleLabel(root, label, excludePatterns) {
    const exclude = excludePatterns || [];
    function labelMatches(txt) {
      return txt.includes(label) && !exclude.some((e) => txt.includes(e));
    }

    // 1) table th/td
    const rows = root.querySelectorAll("tr");
    for (const row of rows) {
      const th = row.querySelector("th");
      if (th && labelMatches(getText(th))) {
        const td = row.querySelector("td");
        if (td) {
          const v = getText(td);
          if (v) return v;
        }
      }
    }

    // 2) dl dt/dd
    const dts = root.querySelectorAll("dt");
    for (const dt of dts) {
      if (labelMatches(getText(dt))) {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === "DD") {
          const v = getText(dd);
          if (v) return v;
        }
      }
    }

    // 3) 見出し・ラベル要素 + 次の兄弟要素
    const allEls = root.querySelectorAll("th, dt, [class*='label'], strong, b, span, div, p");
    for (const el of allEls) {
      const txt = getText(el);
      if (txt.length > 0 && txt.length < 20 && labelMatches(txt)) {
        // 同一要素内にラベルと値が両方入っているケース（例: "電話番号：03-1234-5678"）
        const inline = txt.replace(label, "").replace(/[：:]/, "").trim();
        if (inline && inline !== txt) return inline;

        // 次の兄弟要素
        let sib = el.nextElementSibling;
        if (sib) {
          const sibText = getText(sib);
          if (sibText) return sibText;
        }
        // 同じ親要素内の後続テキスト
        const parent = el.parentElement;
        if (parent) {
          const parentText = getText(parent);
          const idx = parentText.indexOf(txt);
          if (idx >= 0) {
            const rest = parentText.slice(idx + txt.length).trim();
            if (rest) return rest;
          }
        }
      }
    }

    return "";
  }

  /**
   * ページ全体から「ラベル文言」に対応する「値」を探す汎用関数。
   * labelCandidates は優先順位付きの配列として扱い、先頭のラベルから順番に探して
   * 最初に見つかった値を採用する（複数ラベルを無差別にORで探索しない）。
   * excludePatterns に指定した文言を含むラベル要素は除外する
   * （例:「名称」を探す際に「名称カナ」を誤って拾わないようにする）。
   */
  function findValueByLabels(root, labelCandidates, excludePatterns) {
    for (const label of labelCandidates || []) {
      const v = findValueForSingleLabel(root, label, excludePatterns);
      if (v) return v;
    }
    return "";
  }

  /**
   * tel: リンクから電話番号候補を集める。
   * hrefは数字のみの場合が多いため、画面表示側にハイフン付きの表記があれば
   * そちらを優先して採用する（市外局番の誤推測を避けるため）。
   */
  function collectTelLinks(root) {
    const links = Array.from(root.querySelectorAll("a[href^='tel:']"));
    return links.map((a) => {
      const hrefValue = a.getAttribute("href").replace(/^tel:/, "");
      const displayText = getText(a);
      const displayHalfWidth = UTIL.toHalfWidth(displayText);
      const preferred = /-/.test(displayHalfWidth) ? displayText : hrefValue;
      return {
        label: getText(a.previousElementSibling) || getText(a.parentElement),
        value: preferred || hrefValue
      };
    });
  }

  // ---------------------------------------------------------
  // 対象ページ確認
  // ---------------------------------------------------------

  function checkPageReadiness() {
    const isTarget = UTIL.isS2400Url(location.hostname, location.pathname);
    if (!isTarget) {
      return { ok: false, reason: "NOT_TARGET_PAGE" };
    }

    if (UTIL.detectBlockedText(document.body ? document.body.innerText : "")) {
      return { ok: false, reason: "BLOCKED" };
    }

    const zeroPatterns = (CFG.zeroResultTextPatterns || []);
    const bodyText = document.body ? document.body.innerText : "";
    const items = queryAllFirstMatch(document, CFG.listItemSelectors);

    if (items.length === 0) {
      if (zeroPatterns.some((p) => bodyText.includes(p))) {
        return { ok: false, reason: "ZERO_RESULTS" };
      }
      return { ok: false, reason: "NO_LIST_FOUND" };
    }

    // 詳細への遷移要素が最低1つ存在するか
    const hasDetailLink = items.some(
      (item) => queryFirst(item, CFG.detailLinkSelectors) !== null
    );
    if (!hasDetailLink) {
      return { ok: false, reason: "NO_DETAIL_LINK" };
    }

    return { ok: true, count: items.length };
  }

  // ---------------------------------------------------------
  // 検索結果一覧の抽出
  // ---------------------------------------------------------

  function extractFacilityFromListItem(item) {
    const nameEl = queryFirst(item, CFG.nameSelectors);
    const name = UTIL.normalizeClinicName(getText(nameEl) || getText(item).slice(0, 60));

    const detailEl = queryFirst(item, CFG.detailLinkSelectors);
    let detailUrl = "";
    let facilityCode = "";

    if (detailEl) {
      if (detailEl.tagName === "A" && detailEl.getAttribute("href")) {
        try {
          detailUrl = new URL(detailEl.getAttribute("href"), location.href).href;
        } catch (e) {
          detailUrl = "";
        }
      }

      // ナビイの詳細リンクは "kikanCd=1420170408" のようなクエリパラメータで
      // 機関コードを保持しているため、これを最優先で採用する。
      if (detailUrl) {
        try {
          const kikanCd = new URL(detailUrl).searchParams.get("kikanCd");
          if (kikanCd) facilityCode = kikanCd;
        } catch (e) {
          /* noop */
        }
      }

      // onclick / data属性から施設コードらしき値を推測（kikanCdが取れない場合のみ）
      const onclick = detailEl.getAttribute("onclick") || "";
      const dataAttrs = Array.from(detailEl.attributes || [])
        .filter((a) => a.name.startsWith("data-"))
        .map((a) => a.value);
      if (!facilityCode) {
        const codeCandidates = [onclick, ...dataAttrs].join(" ");
        const codeMatch = codeCandidates.match(/[A-Za-z0-9]{6,}/);
        if (codeMatch) facilityCode = codeMatch[0];
      }

      if (!detailUrl && !onclick) {
        // form action を利用しているケース
        const form = detailEl.closest("form");
        if (form && form.getAttribute("action")) {
          try {
            detailUrl = new URL(form.getAttribute("action"), location.href).href;
          } catch (e) {
            /* noop */
          }
        }
      }
    }

    if (!facilityCode && detailUrl) {
      const m = detailUrl.match(/kikanCd=([A-Za-z0-9]+)/) || detailUrl.match(/id=([A-Za-z0-9]+)/);
      if (m) facilityCode = m[1];
    }

    const rawText = getText(item);
    const postalCode = UTIL.extractPostalCode(rawText);
    const addressLabelVal = findValueByLabels(item, (CFG.detailFieldLabels && CFG.detailFieldLabels.address) || ["住所", "所在地"]);
    const address = UTIL.normalizeAddress(addressLabelVal || rawText);

    const telEntries = collectTelLinks(item);
    const phoneLabelVal = findValueByLabels(item, (CFG.detailFieldLabels && CFG.detailFieldLabels.phone) || ["電話"]);
    if (phoneLabelVal) telEntries.push({ label: "電話", value: phoneLabelVal });
    const phones = UTIL.assignPhoneNumbers(telEntries);

    const departments = findValueByLabels(item, (CFG.detailFieldLabels && CFG.detailFieldLabels.departments) || ["診療科目"]);

    const hasFacilitySignal = Boolean(
      detailUrl || phones.tel1 || postalCode || (address && address.length > 5 && /\d/.test(address))
    );

    if (UTIL.isNonFacilityNoiseText(name, hasFacilitySignal)) {
      return null;
    }

    return {
      name,
      postalCode,
      address,
      tel1: phones.tel1,
      departments: UTIL.safeStr(departments),
      detailUrl,
      facilityCode
    };
  }

  function extractListPage() {
    const items = queryAllFirstMatch(document, CFG.listItemSelectors);
    const rawFacilities = items.map(extractFacilityFromListItem).filter((f) => f && (f.name || f.detailUrl));

    // 同一の名前・住所・詳細URLが連続する場合は、DOM構造上の重複描画とみなして1件に潰す
    const facilities = [];
    for (const f of rawFacilities) {
      const prev = facilities[facilities.length - 1];
      const isSameAsPrev =
        prev && prev.name === f.name && prev.address === f.address && prev.detailUrl === f.detailUrl;
      if (!isSameAsPrev) facilities.push(f);
    }

    const bodyText = document.body ? document.body.innerText : "";
    let totalCount = null;
    const countMatch = bodyText.match(/(\d+)\s*件/);
    if (countMatch) totalCount = parseInt(countMatch[1], 10);

    let currentPage = null;
    let totalPages = null;
    const pageMatch = bodyText.match(/(\d+)\s*\/\s*(\d+)\s*ページ/);
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10);
      totalPages = parseInt(pageMatch[2], 10);
    }

    const firstName = facilities[0] ? facilities[0].name : "";
    const lastName = facilities.length ? facilities[facilities.length - 1].name : "";
    const detailUrls = facilities.map((f) => f.detailUrl);
    const fingerprint = UTIL.makePageFingerprint(currentPage || 0, firstName, lastName, detailUrls);

    return { facilities, totalCount, currentPage, totalPages, fingerprint };
  }

  // ---------------------------------------------------------
  // ページネーション（次へ）
  // ---------------------------------------------------------

  function findNextButton() {
    const candidates = queryAllFirstMatch(document, CFG.nextButtonSelectors);
    const textPatterns = CFG.nextButtonTextPatterns || ["次へ"];

    for (const el of candidates) {
      const text = getText(el) || el.getAttribute("aria-label") || el.getAttribute("title") || "";
      const isDisabled =
        el.hasAttribute("disabled") ||
        el.getAttribute("aria-disabled") === "true" ||
        (el.className || "").toString().includes("disabled");
      if (isDisabled) continue;
      if (textPatterns.some((p) => text.includes(p))) {
        return el;
      }
    }
    // フォールバック：候補の最後の要素（ページネーション内の「次」位置に多い）
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  function clickNextPageAndWait(previousFingerprint, timeoutMs) {
    return new Promise((resolve) => {
      const nextBtn = findNextButton();
      if (!nextBtn) {
        resolve({ ok: false, reason: "NO_NEXT_BUTTON" });
        return;
      }

      let resolved = false;
      const timeout = setTimeout(() => {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        resolve({ ok: false, reason: "TIMEOUT" });
      }, timeoutMs || 15000);

      const observer = new MutationObserver(() => {
        checkChanged();
      });
      observer.observe(document.body, { childList: true, subtree: true });

      function checkChanged() {
        if (resolved) return;
        const current = extractListPage();
        if (current.fingerprint && current.fingerprint !== previousFingerprint) {
          resolved = true;
          clearTimeout(timeout);
          observer.disconnect();
          resolve({ ok: true, page: current });
        }
      }

      try {
        nextBtn.click();
      } catch (e) {
        resolved = true;
        clearTimeout(timeout);
        observer.disconnect();
        resolve({ ok: false, reason: "CLICK_FAILED" });
        return;
      }

      // クリック直後にも一度チェック（同期的にDOMが変わるケース）
      setTimeout(checkChanged, 300);
    });
  }

  // ---------------------------------------------------------
  // 診療時間表の解析（table/dl/divグリッド/aria-label に対応）
  // ---------------------------------------------------------

  /**
   * ページ内から曜日別の診療時間らしき { weekday, cellText } の組を収集する。
   * 以下の形式に対応する。
   *   table > tr > th + td（曜日が列見出し／行見出しの両方）
   *   dl > dt + dd
   *   ラベル要素（class名にweek/day/schedule/time等を含む）+ 隣接要素
   *   aria-label 属性に曜日と時刻が含まれる要素
   */
  function extractScheduleEntries(root) {
    const entries = [];

    // 1) table
    const tables = root.querySelectorAll("table");
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (!rows.length) continue;

      // ケースA: 各行の先頭セルが曜日（行見出し = 曜日が行）
      let matchedAsRowHeader = false;
      for (const row of rows) {
        const firstCell = row.querySelector("th, td");
        if (!firstCell) continue;
        const wd = UTIL.normalizeWeekdayToken(getText(firstCell));
        if (wd) {
          matchedAsRowHeader = true;
          const cells = Array.from(row.querySelectorAll("td"));
          const cellText = cells.length ? cells.map(getText).join(" / ") : "";
          entries.push({ weekday: wd, cellText });
        }
      }
      if (matchedAsRowHeader) continue;

      // ケースB: 先頭行が曜日の列見出し（曜日が列）
      const headerRow = rows[0];
      const headerCells = Array.from(headerRow.querySelectorAll("th, td"));
      const colWeekdays = headerCells.map((c) => UTIL.normalizeWeekdayToken(getText(c)));
      if (colWeekdays.some(Boolean)) {
        for (let i = 1; i < rows.length; i++) {
          const cells = Array.from(rows[i].querySelectorAll("th, td"));
          cells.forEach((cell, idx) => {
            const wd = colWeekdays[idx];
            if (wd) entries.push({ weekday: wd, cellText: getText(cell) });
          });
        }
      }
    }

    // 2) dl > dt + dd
    const dts = root.querySelectorAll("dt");
    for (const dt of dts) {
      const wd = UTIL.normalizeWeekdayToken(getText(dt));
      if (wd) {
        const dd = dt.nextElementSibling;
        if (dd && dd.tagName === "DD") entries.push({ weekday: wd, cellText: getText(dd) });
      }
    }

    // 3) divグリッド（曜日ラベル要素 + 隣接要素）
    const gridLabelEls = root.querySelectorAll(
      "[class*='week'], [class*='schedule'], [class*='day'], [class*='time']"
    );
    for (const el of gridLabelEls) {
      const txt = getText(el);
      if (txt && txt.length <= 6) {
        const wd = UTIL.normalizeWeekdayToken(txt);
        if (wd) {
          const sib = el.nextElementSibling;
          if (sib) entries.push({ weekday: wd, cellText: getText(sib) });
        }
      }
    }

    // 4) aria-label 付き要素（例: aria-label="月曜日 09:00から12:00"）
    const ariaEls = root.querySelectorAll("[aria-label]");
    for (const el of ariaEls) {
      const label = el.getAttribute("aria-label") || "";
      const wd = UTIL.normalizeWeekdayToken(label.replace(/[^\u4e00-\u9fa0\u3040-\u309F\u30A0-\u30FF]+.*$/, ""));
      if (wd && /\d/.test(label)) {
        entries.push({ weekday: wd, cellText: label });
      }
    }

    return entries;
  }

  /** DOM変化が落ち着くまで（デバウンス）待つ簡易ヘルパー */
  function waitForDomSettled(maxWaitMs) {
    return new Promise((resolve) => {
      let resolved = false;
      let debounceTimer = setTimeout(finish, maxWaitMs);

      const observer = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(finish, 300);
      });
      observer.observe(document.body, { childList: true, subtree: true });

      function finish() {
        if (resolved) return;
        resolved = true;
        observer.disconnect();
        resolve();
      }
    });
  }

  /**
   * 「診療時間」「診療科目」等のタブ・見出しを探して開き（非アクティブなら1回クリックし）、
   * 各タブを開くたびにその時点のDOMから診療時間らしき情報を収集して統合する。
   * PC/レスポンシブ、aタグ/button/JSイベントのいずれのタブ実装にも同じロジックで対応する。
   */
  async function collectScheduleEntriesAcrossTabs() {
    const combined = [];
    const seen = new Set();
    function mergeIn(entries) {
      for (const e of entries) {
        const key = `${e.weekday}__${e.cellText}`;
        if (!seen.has(key)) {
          seen.add(key);
          combined.push(e);
        }
      }
    }

    // まず現在表示中の状態から収集（タブが無いページ・折りたたみが無いページに対応）
    mergeIn(extractScheduleEntries(document));

    const tabKeywords = CFG.scheduleTabKeywords || ["診療時間", "診療内容", "基本情報"];
    const tabCandidates = Array.from(
      document.querySelectorAll("[role='tab'], a[href^='#'], button, [class*='tab']")
    );
    const relevantTabs = tabCandidates.filter((el) => {
      const text = getText(el);
      return text && text.length < 40 && tabKeywords.some((k) => text.includes(k));
    });

    let tabFound = relevantTabs.length > 0;
    let tabOpened = false;

    for (const el of relevantTabs) {
      const classStr = (el.className || "").toString();
      const isActive = el.getAttribute("aria-selected") === "true" || classStr.includes("active") || classStr.includes("current");
      if (!isActive) {
        try {
          el.click();
          tabOpened = true;
          await waitForDomSettled(1200);
          mergeIn(extractScheduleEntries(document));
        } catch (e) {
          /* クリックできないタブは無視して次へ */
        }
      } else {
        mergeIn(extractScheduleEntries(document));
      }
    }

    return { entries: combined, tabFound, tabOpened };
  }

  async function extractDetailPage(searchResultName) {
    if (UTIL.detectBlockedText(document.body ? document.body.innerText : "")) {
      return { ok: false, reason: "BLOCKED" };
    }

    const L = CFG.detailFieldLabels;
    const root = document;
    const debug = {
      detailUrl: location.href,
      searchResultName: UTIL.safeStr(searchResultName),
      officialNameCandidate: "",
      kanaCandidate: "",
      usedNameSource: "",
      usedKanaLabel: "",
      detectedFacilityType: "",
      scheduleTabFound: false,
      scheduleTabOpened: false,
      detectedWeekdayCount: 0,
      detectedSlotCount: 0,
      detectedClosedDays: [],
      detectedExternalUrl: "",
      parseErrors: []
    };

    // --- 名前・カナ ---
    let nameLabelValue = "";
    let nameKana = "";
    try {
      nameLabelValue = UTIL.normalizeClinicName(
        findValueByLabels(root, L.name, CFG.nameExcludePatterns || ["カナ", "フリガナ"])
      );
      nameKana = UTIL.safeStr(findValueByLabels(root, L.nameKana));
    } catch (e) {
      debug.parseErrors.push(`名前/カナ取得エラー: ${e && e.message ? e.message : e}`);
    }

    let headingText = "";
    if (!nameLabelValue) {
      const headingEl = queryFirst(root, CFG.nameHeadingSelectors || ["h1"]);
      headingText = UTIL.normalizeClinicName(getText(headingEl));
    }

    const nameDecision = UTIL.decideFacilityName(nameLabelValue, headingText, searchResultName);
    const officialName = nameDecision.name;
    debug.officialNameCandidate = nameLabelValue || headingText || "";
    debug.kanaCandidate = nameKana;
    debug.usedNameSource = nameDecision.source;
    debug.usedKanaLabel = nameKana ? "取得済み" : "";

    // --- 住所 ---
    const postalRaw = findValueByLabels(root, L.postalCode);
    const addressRaw = findValueByLabels(root, L.address);
    const addressKana = UTIL.safeStr(findValueByLabels(root, L.addressKana));

    const postalCode = UTIL.extractPostalCode(postalRaw || addressRaw);
    const fullAddress = UTIL.normalizeAddress(addressRaw);
    const prefecture = UTIL.extractPrefecture(fullAddress);
    const { addr1, addr2 } = UTIL.splitAddress(fullAddress);

    // --- 電話・FAX ---
    const phoneText = findValueByLabels(root, L.phone);
    const faxText = findValueByLabels(root, L.fax);
    const telEntries = collectTelLinks(root);
    if (phoneText) telEntries.push({ label: "電話", value: phoneText });
    if (faxText) telEntries.push({ label: "FAX", value: faxText });
    const phones = UTIL.assignPhoneNumbers(telEntries);

    // --- URL（公式HP） ---
    let officialUrl = "";
    try {
      officialUrl = extractOfficialUrl(root, L.url);
    } catch (e) {
      debug.parseErrors.push(`URL取得エラー: ${e && e.message ? e.message : e}`);
    }
    debug.detectedExternalUrl = officialUrl;

    // --- 診療科目 ---
    const departments = UTIL.safeStr(findValueByLabels(root, L.departments));

    // --- 種別（ラベル値のみを判定対象にする。医院名からは判定しない） ---
    let facilityType = "";
    try {
      const typeLabelValue = findValueByLabels(root, CFG.facilityTypeLabels || ["機関区分", "医療機関種別"]);
      facilityType = UTIL.determineFacilityType(typeLabelValue);
    } catch (e) {
      debug.parseErrors.push(`種別取得エラー: ${e && e.message ? e.message : e}`);
    }
    debug.detectedFacilityType = facilityType;

    // --- 診療時間（タブ・折りたたみ領域を含めて横断的に解析） ---
    let hoursByWeekday = {};
    let explicitClosedWeekdays = [];
    let presentWeekdays = [];
    try {
      const scheduleResult = await collectScheduleEntriesAcrossTabs();
      debug.scheduleTabFound = scheduleResult.tabFound;
      debug.scheduleTabOpened = scheduleResult.tabOpened;
      const built = UTIL.buildHoursByWeekdayFromEntries(scheduleResult.entries);
      hoursByWeekday = built.hoursByWeekday;
      explicitClosedWeekdays = built.explicitClosedWeekdays;
      presentWeekdays = built.presentWeekdays;
    } catch (e) {
      debug.parseErrors.push(`診療時間取得エラー: ${e && e.message ? e.message : e}`);
    }

    const clinicDays = UTIL.determineClinicDays(hoursByWeekday);
    const repHours = UTIL.determineRepresentativeHours(hoursByWeekday);
    debug.detectedWeekdayCount = presentWeekdays.length;
    debug.detectedSlotCount = Object.values(hoursByWeekday).reduce((sum, arr) => sum + (arr ? arr.length : 0), 0);

    // --- 休診日 ---
    const closedDaysLabelText = findValueByLabels(root, L.closedDays);
    const closedDaysFromLabel = UTIL.extractClosedDays(closedDaysLabelText);
    const closedDays = UTIL.determineClosedDays(
      closedDaysFromLabel,
      explicitClosedWeekdays,
      hoursByWeekday,
      presentWeekdays
    );
    debug.detectedClosedDays = closedDays;

    // --- 院長名・管理者名 ---
    const director = UTIL.safeStr(findValueByLabels(root, L.director));

    // --- 開設年月日 ---
    const openedRaw = findValueByLabels(root, L.openedDate);
    let openedDate = "";
    if (openedRaw) {
      const s = UTIL.toHalfWidth(openedRaw);
      const full = s.match(/(\d{4})[\/年](\d{1,2})[\/月](\d{1,2})/);
      const ym = s.match(/(\d{4})[\/年](\d{1,2})/);
      if (full) {
        openedDate = `${full[1]}/${full[2].padStart(2, "0")}/${full[3].padStart(2, "0")}`;
      } else if (ym) {
        openedDate = `${ym[1]}/${ym[2].padStart(2, "0")}`;
      }
    }

    // --- 備考 ---
    const remarksParts = [];
    const scheduleSummary = UTIL.buildScheduleSummaryText(hoursByWeekday);
    if (scheduleSummary) remarksParts.push(`診療時間:${scheduleSummary}`);
    if (repHours.diffNote) remarksParts.push(`曜日差異:${repHours.diffNote}`);
    if (phones.extraNote && phones.extraNote.length) remarksParts.push(`追加電話:${phones.extraNote.join(",")}`);
    const remarks = UTIL.buildRemarksText(remarksParts);

    return {
      ok: true,
      data: {
        officialName,
        nameKana,
        searchResultName: UTIL.safeStr(searchResultName),
        postalCode,
        prefecture,
        addr1,
        addr2,
        addressKana,
        tel1: phones.tel1,
        tel2: phones.tel2,
        tel3: phones.tel3,
        tel4: phones.tel4,
        fax: phones.fax,
        url: officialUrl,
        departments,
        clinicDays,
        closedDays,
        amStart: repHours.amStart,
        amEnd: repHours.amEnd,
        pmStart: repHours.pmStart,
        pmEnd: repHours.pmEnd,
        director,
        openedDate,
        facilityType,
        remarks,
        detailUrl: location.href
      },
      debug
    };
  }

  /**
   * 公式HP URLを、ラベル要素の親・同じtr・次の兄弟の範囲から探す。
   * href属性を優先し、リンクが無い場合はテキスト中のURLパターンも許容する。
   */
  function extractOfficialUrl(root, urlLabels) {
    for (const label of urlLabels || []) {
      const container = Array.from(root.querySelectorAll("th, dt, span, div, p, td, dd")).find(
        (el) => getText(el).includes(label) && getText(el).length < 30
      );
      if (!container) continue;

      const scopeCandidates = [container.parentElement, container.closest("tr"), container.nextElementSibling].filter(
        Boolean
      );

      for (const scope of scopeCandidates) {
        const a = scope.querySelector ? scope.querySelector("a[href]") : null;
        if (a) {
          const href = a.getAttribute("href");
          try {
            const abs = new URL(href, location.href).href;
            if (!UTIL.isExcludedUrl(abs)) return abs;
          } catch (e) {
            /* noop */
          }
        }
      }

      for (const scope of scopeCandidates) {
        const text = (scope.textContent || "").trim();
        const m = text.match(/https?:\/\/[^\s"'<>]+/);
        if (m && !UTIL.isExcludedUrl(m[0])) return m[0];
      }
    }
    return "";
  }

  // ---------------------------------------------------------
  // メッセージハンドラ
  // ---------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    switch (message.type) {
      case "NAVII_CHECK_READY":
        sendResponse(checkPageReadiness());
        return true;

      case "NAVII_EXTRACT_LIST":
        sendResponse({ ok: true, ...extractListPage() });
        return true;

      case "NAVII_NEXT_PAGE":
        clickNextPageAndWait(message.previousFingerprint, message.timeoutMs).then(sendResponse);
        return true; // 非同期応答

      case "NAVII_EXTRACT_DETAIL":
        extractDetailPage(message.searchResultName).then(sendResponse);
        return true; // 非同期応答

      case "NAVII_TEST_CURRENT_PAGE":
        // 「このページをテスト」機能：現在のページのみを解析して結果を返す（ページ遷移なし）
        extractDetailPage(message.searchResultName || "").then((result) => {
          sendResponse(Object.assign({ isTestMode: true }, result));
        });
        return true; // 非同期応答

      case "NAVII_CHECK_BLOCKED":
        sendResponse({
          blocked: UTIL.detectBlockedText(document.body ? document.body.innerText : "")
        });
        return true;

      default:
        return false;
    }
  });
})();
