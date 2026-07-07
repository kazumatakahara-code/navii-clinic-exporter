/**
 * utils.js
 * ---------------------------------------------------------
 * DOM解析ではない「純粋な」正規化・判定ロジックを集約する。
 * content.js / background.js / tests から共通で利用する。
 * このファイルはブラウザのグローバルスコープに NaviiUtils を公開する。
 * ---------------------------------------------------------
 */

/* global window, NaviiConfig */
(function (global) {
  "use strict";

  const CFG = global.NaviiConfig || {};

  // ---------------------------------------------------------
  // 共通ヘルパー
  // ---------------------------------------------------------

  /** null / undefined / 空文字を安全に空文字へ変換する */
  function safeStr(v) {
    if (v === null || v === undefined) return "";
    return String(v).trim();
  }

  /** 全角数字・全角記号を半角へ変換する */
  function toHalfWidth(str) {
    if (!str) return "";
    return String(str)
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[－―ー−]/g, "-")
      .replace(/[（）]/g, (c) => (c === "（" ? "(" : ")"))
      .replace(/[：]/g, ":")
      .replace(/[／]/g, "/");
  }

  // ---------------------------------------------------------
  // 1. S2400 URL判定
  // ---------------------------------------------------------
  function isS2400Url(hostname, pathname) {
    const target = CFG.target || {
      hostname: "www.iryou.teikyouseido.mhlw.go.jp",
      pathIncludes: "/znk-web/juminkanja/S2400/"
    };
    return (
      safeStr(hostname) === target.hostname &&
      safeStr(pathname).includes(target.pathIncludes)
    );
  }

  // ---------------------------------------------------------
  // 2. 電話番号正規化 / 3. FAX判定
  // ---------------------------------------------------------

  /**
   * ラベルや前後テキストからFAX表記かどうかを判定する。
   */
  function isFaxLabel(text) {
    const patterns = (CFG.faxLabelPatterns || ["FAX", "Fax", "fax", "ファックス"]);
    const t = safeStr(text);
    return patterns.some((p) => t.includes(p));
  }

  /**
   * 電話番号らしき文字列を正規化し、ラベルや括弧・注記を除去する。
   * 戻り値: { display: "03-1234-5678", digits: "0312345678", isFax: boolean, note: string }
   * 正規化できない場合は null を返す。
   */
  function normalizePhone(raw) {
    if (!raw) return null;
    let s = toHalfWidth(safeStr(raw));

    const isFax = isFaxLabel(s);

    // ラベル的な接頭辞（例: 代表：, 予約専用：, （昼）, FAX：）を除去
    s = s.replace(/^[（(]?[^0-9()\-–—]{0,10}[）)]?[：:]?/g, "").trim();
    // 残った不要な括弧・記号を除去（数字・ハイフン・カッコ以外は削除）
    s = s.replace(/[^\d\-()]/g, "");
    // 電話番号内の丸括弧はハイフンとして扱う（例: (048)-969-2222）
    s = s.replace(/[()]/g, "-");
    // 連続ハイフンを1つに、先頭末尾のハイフンを除去
    s = s.replace(/-+/g, "-").replace(/^-|-$/g, "");

    const digits = s.replace(/-/g, "");
    if (digits.length < 9 || digits.length > 11 || !/^\d+$/.test(digits)) {
      return null;
    }

    // 表示用にハイフン付きへ整形（すでにハイフンがあればそれを尊重し、無ければ推定しない）
    const display = s.includes("-") ? s : digits;

    return {
      display,
      digits,
      isFax,
      note: raw && raw !== display ? safeStr(raw) : ""
    };
  }

  /**
   * 詳細ページ等から取得した「ラベル: 値」の配列を Tel1-4 / FAX / 備考に振り分ける。
   * entries: [{label, value}]
   */
  function assignPhoneNumbers(entries) {
    const result = { tel: [], fax: [], extraNote: [] };
    const seen = new Set();

    for (const entry of entries || []) {
      const parsed = normalizePhone(entry.value);
      if (!parsed) continue;
      const labelSaysFax = isFaxLabel(entry.label) || parsed.isFax;

      if (labelSaysFax) {
        if (!result.fax.includes(parsed.display)) result.fax.push(parsed.display);
        continue;
      }
      if (seen.has(parsed.digits)) continue;
      seen.add(parsed.digits);
      result.tel.push({ display: parsed.display, label: safeStr(entry.label) });
    }

    // 「代表」「昼」などのヒントがあるものを優先してTel1に
    const hintPatterns = CFG.primaryPhoneHintPatterns || ["代表", "昼"];
    result.tel.sort((a, b) => {
      const aHint = hintPatterns.some((p) => a.label.includes(p)) ? 0 : 1;
      const bHint = hintPatterns.some((p) => b.label.includes(p)) ? 0 : 1;
      return aHint - bHint;
    });

    const tel1 = result.tel[0] ? result.tel[0].display : "";
    const tel2 = result.tel[1] ? result.tel[1].display : "";
    const tel3 = result.tel[2] ? result.tel[2].display : "";
    const tel4 = result.tel[3] ? result.tel[3].display : "";
    const extra = result.tel.slice(4).map((t) => `${t.label ? t.label + ":" : ""}${t.display}`);

    return {
      tel1, tel2, tel3, tel4,
      fax: result.fax[0] || "",
      extraNote: extra
    };
  }

  // ---------------------------------------------------------
  // 4. 医院名正規化
  // ---------------------------------------------------------
  function normalizeClinicName(raw) {
    let s = safeStr(raw);
    s = s.replace(/\s+/g, " ").trim();
    // 前後の「詳細」「>」などの装飾記号を除去
    s = s.replace(/^[>\s・]+|[>\s・]+$/g, "");
    return s;
  }

  // ---------------------------------------------------------
  // 5. 住所正規化 / 6. 郵便番号抽出 / 7. 都道府県抽出 / 8. 住所１・住所２分割
  // ---------------------------------------------------------

  function normalizeAddress(raw) {
    let s = toHalfWidth(safeStr(raw));
    s = s.replace(/\s+/g, " ").trim();
    return s;
  }

  function extractPostalCode(raw) {
    const s = toHalfWidth(safeStr(raw));
    const m = s.match(/(\d{3})-?(\d{4})/);
    if (!m) return "";
    return `${m[1]}-${m[2]}`;
  }

  function extractPrefecture(raw) {
    const s = safeStr(raw);
    const list = CFG.prefectures || [];
    for (const pref of list) {
      if (s.includes(pref)) return pref;
    }
    return "";
  }

  /**
   * 住所全体から 郵便番号・都道府県 を除いた残りを 住所１ / 住所２ に分割する。
   * 住所２（建物名等）は「番地の後にビル・マンション・階などが続く」パターンで簡易判定する。
   * 正確に分割できない場合は住所１に全体を入れ、住所２は空にする（推測しない）。
   */
  function splitAddress(fullAddress) {
    let s = normalizeAddress(fullAddress);
    // 郵便番号を除去
    s = s.replace(/〒?\s*\d{3}-?\d{4}\s*/g, "").trim();
    // 都道府県を除去
    const pref = extractPrefecture(s);
    if (pref) {
      s = s.replace(pref, "").trim();
    }

    if (!s) return { addr1: "", addr2: "" };

    // 建物名らしきキーワードを含むかどうかの判定
    const buildingPattern = /(ビル|マンション|タワー|プラザ|センター|クリニックモール|棟|号室|階|F\b)/;

    // 住所文字列中に空白があり、かつ空白より後ろの部分が建物名らしい場合のみ、
    // その空白を境に 住所１ / 住所２ を分割する（推測を避けるための保守的なルール）。
    const spaceIndex = s.search(/\s/);
    if (spaceIndex > -1) {
      const before = s.slice(0, spaceIndex).trim();
      const after = s.slice(spaceIndex).trim();
      if (before && after && buildingPattern.test(after)) {
        return { addr1: before, addr2: after };
      }
    }

    // 正確に分割できない場合は住所全体を住所１に入れる（誤った推測による分割をしない）
    return { addr1: s, addr2: "" };
  }

  // ---------------------------------------------------------
  // 9. 曜日正規化 / 10. 休診日抽出
  // ---------------------------------------------------------

  const WEEKDAY_ORDER = (CFG.weekdayOrder || ["月", "火", "水", "木", "金", "土", "日", "祝"]);

  function normalizeWeekdayList(days) {
    const set = new Set();
    for (const d of days || []) {
      const s = safeStr(d);
      for (const w of WEEKDAY_ORDER) {
        if (s.includes(w)) set.add(w);
      }
    }
    return WEEKDAY_ORDER.filter((w) => set.has(w));
  }

  function sortWeekdays(days) {
    return normalizeWeekdayList(days);
  }

  /**
   * 「水曜・日曜・祝日休診」のような文言から休診日を抽出する。
   * 明示的な記載がない場合は空配列を返す（判断できない場合は空欄）。
   */
  function extractClosedDays(text) {
    const s = safeStr(text);
    if (!s) return [];
    if (!/休診|休み|お休み/.test(s)) return [];
    const found = [];
    for (const w of WEEKDAY_ORDER) {
      if (s.includes(w)) found.push(w);
    }
    return sortWeekdays(found);
  }

  // ---------------------------------------------------------
  // 11. 診療時間解析 / 12. 午前・午後の代表時間決定
  // ---------------------------------------------------------

  /**
   * 「月 09:00-12:00 / 15:00-18:00」のような曜日別診療時間テキストの配列を解析する。
   * 戻り値: { "月": ["09:00-12:00","15:00-18:00"], ... }
   */
  function parseClinicHours(lines) {
    const result = {};
    for (const rawLine of lines || []) {
      const line = toHalfWidth(safeStr(rawLine));
      if (!line) continue;
      const weekdayMatch = WEEKDAY_ORDER.find((w) => line.startsWith(w) || line.includes(w));
      if (!weekdayMatch) continue;
      const timeMatches = line.match(/\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/g);
      if (!timeMatches) continue;
      const normalized = timeMatches.map((t) => t.replace(/\s+/g, ""));
      if (!result[weekdayMatch]) result[weekdayMatch] = [];
      result[weekdayMatch].push(...normalized);
    }
    return result;
  }

  /**
   * 曜日別診療時間から、午前始・午前終・午後始・午後終の代表値を決定する。
   * 判断できない場合は空欄。曜日ごとの差異は notes に文字列として返す（呼び出し側で備考へ）。
   */
  function determineRepresentativeHours(hoursByWeekday) {
    const weekdayPriority = ["月", "火", "水", "木", "金", "土", "日"];
    const amCandidates = {};
    const pmCandidates = {};
    const usedWeekdays = weekdayPriority.filter((w) => hoursByWeekday[w] && hoursByWeekday[w].length);
    const priorityWeekdays = usedWeekdays.filter((w) => ["月", "火", "水", "木", "金"].includes(w));
    const targetWeekdays = priorityWeekdays.length ? priorityWeekdays : usedWeekdays;

    for (const w of targetWeekdays) {
      for (const range of hoursByWeekday[w]) {
        const [start, end] = range.split("-");
        if (!start || !end) continue;
        const startHour = parseInt(start.split(":")[0], 10);
        const bucket = startHour < 12 ? amCandidates : pmCandidates;
        const key = `${start}-${end}`;
        bucket[key] = (bucket[key] || 0) + 1;
      }
    }

    function pickMostFrequent(bucket) {
      let best = null;
      let bestCount = 0;
      for (const [key, count] of Object.entries(bucket)) {
        if (count > bestCount) {
          best = key;
          bestCount = count;
        }
      }
      return best;
    }

    const amBest = pickMostFrequent(amCandidates);
    const pmBest = pickMostFrequent(pmCandidates);

    const [amStart, amEnd] = amBest ? amBest.split("-") : ["", ""];
    const [pmStart, pmEnd] = pmBest ? pmBest.split("-") : ["", ""];

    // 曜日ごとの差異を検出（代表時間と異なる曜日があれば備考用メモを作る）
    const diffNotes = [];
    for (const w of usedWeekdays) {
      const ranges = hoursByWeekday[w].join("/");
      const isSameAsRepresentative =
        hoursByWeekday[w].includes(amBest) || hoursByWeekday[w].includes(pmBest);
      if (!isSameAsRepresentative || hoursByWeekday[w].length > (amBest && pmBest ? 2 : 1)) {
        diffNotes.push(`${w}は${ranges}`);
      }
    }

    return {
      amStart: amStart || "",
      amEnd: amEnd || "",
      pmStart: pmStart || "",
      pmEnd: pmEnd || "",
      diffNote: diffNotes.join("、")
    };
  }

  /** 診療日（1つ以上の診療時間が確認できた曜日）を決定する */
  function determineClinicDays(hoursByWeekday) {
    const days = Object.keys(hoursByWeekday || {}).filter(
      (w) => hoursByWeekday[w] && hoursByWeekday[w].length > 0
    );
    return sortWeekdays(days);
  }

  // ---------------------------------------------------------
  // カタカナ判定 / 医療機関名の最終決定ロジック
  // ---------------------------------------------------------

  /** 全角カタカナ（＋長音符・中黒・スペース）のみで構成されているかを判定する */
  function isKatakanaOnly(text) {
    const s = safeStr(text);
    if (!s) return false;
    return /^[ァ-ヶーヴ・\s]+$/.test(s);
  }

  /**
   * 医療機関名の最終決定ロジック（純粋関数、DOM非依存）。
   * 優先順位:
   *   1. ラベル値（"正式名称"等）… カタカナのみでも、ラベルに基づく値なのでそのまま採用する
   *   2. 見出しの日本語表記（カタカナのみの場合は採用しない）
   *   3. 検索結果一覧の表記
   *   4. どれも無ければ空欄
   * 戻り値: { name, source }
   */
  function decideFacilityName(labelValue, headingText, searchResultName) {
    const label = safeStr(labelValue);
    if (label) return { name: label, source: "label" };

    const heading = safeStr(headingText);
    if (heading && !isKatakanaOnly(heading)) return { name: heading, source: "heading" };

    const fallback = safeStr(searchResultName);
    if (fallback) return { name: fallback, source: "searchResult" };

    return { name: "", source: "" };
  }

  // ---------------------------------------------------------
  // 曜日・時刻表記の正規化（診療時間表解析用）
  // ---------------------------------------------------------

  /**
   * 「月曜日」「水曜」「祝日」などの表記を、固定の1文字表記（月/火/水/木/金/土/日/祝）へ正規化する。
   * 該当しない場合は空文字を返す。
   */
  function normalizeWeekdayToken(text) {
    const s = safeStr(text).replace(/[\s　]+/g, "");
    if (!s) return "";

    const aliases = CFG.weekdayLabelAliases || {};
    if (Object.prototype.hasOwnProperty.call(aliases, s)) return aliases[s];

    for (const w of WEEKDAY_ORDER) {
      if (s === w) return w;
    }
    // 前方一致（例:"月曜日(祝日を除く)"のような付加テキストがあるケース）
    for (const [full, short] of Object.entries(aliases)) {
      if (s.startsWith(full)) return short;
    }
    return "";
  }

  /**
   * 「9:00」「９：００」「9時00分」「午前9時」「15時30分」などの時刻表記を
   * "HH:mm" 形式へ正規化する。正規化できない場合は空文字を返す（推測しない）。
   */
  function normalizeTimeToken(raw) {
    let s = toHalfWidth(safeStr(raw)).trim();
    if (!s) return "";

    let ampmOffset = 0;
    const ampmMatch = s.match(/^(午前|午後|am|AM|pm|PM)\s*/);
    if (ampmMatch) {
      if (/午後|pm|PM/i.test(ampmMatch[1])) ampmOffset = 12;
      s = s.slice(ampmMatch[0].length).trim();
    }

    // 9時00分 / 9時
    let m = s.match(/^(\d{1,2})時(\d{1,2})?分?$/);
    if (m) {
      let hour = parseInt(m[1], 10);
      const minute = m[2] ? parseInt(m[2], 10) : 0;
      if (ampmOffset && hour < 12) hour += ampmOffset;
      if (hour > 23 || minute > 59) return "";
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }

    // 9:00 / 09:00
    m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      let hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      if (ampmOffset && hour < 12) hour += ampmOffset;
      if (hour > 23 || minute > 59) return "";
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }

    return "";
  }

  /**
   * 「9:00～12:00」「9時00分から12時00分」のような時間範囲表記を
   * { start, end } (HH:mm形式) へ分解する。分解できない場合は null を返す。
   */
  function splitTimeRangeText(text) {
    let s = toHalfWidth(safeStr(text)).trim();
    if (!s) return null;
    s = s.replace(/[〜～—]/g, "-").replace(/から/g, "-");

    const parts = s.split("-").map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 2) return null;

    const start = normalizeTimeToken(parts[0]);
    const end = normalizeTimeToken(parts[1]);
    if (!start || !end) return null;

    return { start, end };
  }

  /**
   * 診療時間表の1セル分のテキストを解析し、診療時間帯の配列と休診フラグを返す。
   * 「09:00～12:00 / 15:00～18:00」のような複数時間帯や、
   * 「休診」「-」等の休診表記に対応する。
   * 単なる空欄は休診と断定しない（空配列・closed=falseを返す）。
   */
  function parseScheduleCellText(text) {
    const s = toHalfWidth(safeStr(text)).trim();
    if (!s) return { slots: [], closed: false };

    const closedTokens = CFG.closedIndicatorPatterns || ["休診", "休", "-", "－", "―", "×", "なし"];
    const tokens = s.split(/[\/、,\n]+/).map((t) => t.trim()).filter(Boolean);

    const slots = [];
    let closed = false;

    for (const token of tokens) {
      if (closedTokens.includes(token)) {
        closed = true;
        continue;
      }
      const range = splitTimeRangeText(token);
      if (range) {
        const slot = `${range.start}-${range.end}`;
        if (!slots.includes(slot)) slots.push(slot);
      }
    }

    // トークン分割後も時間帯が1つも取れず、休診を示す語だけが含まれていた場合
    if (!slots.length && !closed && closedTokens.some((t) => s === t)) {
      closed = true;
    }

    return { slots, closed };
  }

  /**
   * DOMから収集した { weekday, cellText } の配列から、
   * 曜日別診療時間（hoursByWeekday）・明示的休診曜日・表内に実在した曜日一覧を組み立てる。
   * 同じ曜日が複数回（診療科ごと等）出現する場合は時間帯を統合し、重複除外する。
   */
  function buildHoursByWeekdayFromEntries(entries) {
    const hoursByWeekday = {};
    const explicitClosedWeekdaysSet = new Set();
    const presentWeekdaysSet = new Set();

    for (const entry of entries || []) {
      const weekday = safeStr(entry && entry.weekday);
      if (!weekday) continue;
      presentWeekdaysSet.add(weekday);

      const parsed = parseScheduleCellText(entry.cellText);
      if (parsed.closed) explicitClosedWeekdaysSet.add(weekday);
      if (parsed.slots.length) {
        if (!hoursByWeekday[weekday]) hoursByWeekday[weekday] = [];
        for (const slot of parsed.slots) {
          if (!hoursByWeekday[weekday].includes(slot)) hoursByWeekday[weekday].push(slot);
        }
      }
    }

    return {
      hoursByWeekday,
      explicitClosedWeekdays: sortWeekdays(Array.from(explicitClosedWeekdaysSet)),
      presentWeekdays: sortWeekdays(Array.from(presentWeekdaysSet))
    };
  }

  /**
   * 休診日を優先順位に従って決定する。
   *   1. ページ内の明示的な「休診日」ラベル値
   *   2. 診療時間表のセルで明確に「休診」と表示された曜日
   *   3. 診療時間がある曜日の補集合（月～日の全曜日が表に明示されている場合のみ）
   * 祝日は、明示的な記載がある場合のみ含める（この関数自体は呼び出し側で祝日情報を渡した場合のみ扱う）。
   */
  function determineClosedDays(explicitClosedDaysLabelList, explicitClosedFromCells, hoursByWeekday, presentWeekdays) {
    if (explicitClosedDaysLabelList && explicitClosedDaysLabelList.length) {
      return sortWeekdays(explicitClosedDaysLabelList);
    }
    if (explicitClosedFromCells && explicitClosedFromCells.length) {
      return sortWeekdays(explicitClosedFromCells);
    }

    const mainDays = ["月", "火", "水", "木", "金", "土", "日"];
    const present = presentWeekdays || [];
    const allPresent = mainDays.every((d) => present.includes(d));
    if (allPresent) {
      const openDays = Object.keys(hoursByWeekday || {}).filter(
        (w) => hoursByWeekday[w] && hoursByWeekday[w].length
      );
      const closed = mainDays.filter((d) => !openDays.includes(d));
      return sortWeekdays(closed);
    }

    return [];
  }

  // ---------------------------------------------------------

  /**
   * テキストが「施設ではないノイズ」らしいかどうかを判定する。
   * hasFacilitySignal（電話番号・郵便番号・詳細リンクなど、施設らしさを示す
   * 情報が他に見つかっているか）が false のときのみ、短い設備タグ的文言を
   * ノイズと判定する。施設らしい情報が既にあるものは誤って除外しない。
   */
  function isNonFacilityNoiseText(text, hasFacilitySignal) {
    const s = safeStr(text);
    if (!s) return true; // 名前すら取れない場合はノイズとみなす

    const exactPatterns = CFG.nonFacilityExactPatterns || [];
    // 完全一致は、施設らしい情報の有無に関わらずノイズとみなす
    if (exactPatterns.some((p) => s === p)) return true;

    if (hasFacilitySignal) return false;

    // 施設らしい情報（電話番号・郵便番号・詳細リンク等）が無い場合のみ、
    // 部分一致や短い設備タグ的文言もノイズとみなす
    if (exactPatterns.some((p) => s.includes(p))) return true;

    const suffixPattern = CFG.nonFacilityTagSuffixPattern || /(あり|なし)$/;
    const maxLen = CFG.nonFacilityTagMaxLength || 20;
    if (s.length <= maxLen && suffixPattern.test(s)) return true;

    return false;
  }

  /**
   * 曜日別診療時間（{ "月": ["09:00-12:00", ...], ... }）を、
   * 備考欄に入れやすい整形済みの1行テキストに変換する。
   * タブ・改行・余分な空白を含めない。
   */
  function buildScheduleSummaryText(hoursByWeekday) {
    if (!hoursByWeekday) return "";
    const parts = [];
    for (const w of WEEKDAY_ORDER) {
      const ranges = hoursByWeekday[w];
      if (ranges && ranges.length) {
        parts.push(`${w}${ranges.join("/")}`);
      }
    }
    return parts.join("、");
  }

  /**
   * 備考欄に入れる複数の断片を、改行を含まない1行のテキストへ整形して結合する。
   * 各断片は前後の空白・タブ・改行を除去し、内部の連続空白を1つにまとめる。
   */
  function buildRemarksText(parts) {
    const cleaned = (parts || [])
      .map((p) => safeStr(p).replace(/\s+/g, " ").trim())
      .filter((p) => p && p !== "-");
    return cleaned.join("／");
  }

  // ---------------------------------------------------------
  // 13. URL除外判定
  // ---------------------------------------------------------
  function isExcludedUrl(url) {
    const s = safeStr(url);
    if (!s) return true;
    const exclusions = (CFG.urlExclusions) || {
      domains: ["iryou.teikyouseido.mhlw.go.jp", "mhlw.go.jp"],
      schemes: ["javascript:", "mailto:", "tel:"],
      extensions: [".pdf"],
      snsDomains: []
    };

    const lower = s.toLowerCase();
    if (exclusions.schemes.some((sch) => lower.startsWith(sch))) return true;
    if (!/^https?:\/\//.test(lower)) return true;
    if (exclusions.extensions.some((ext) => lower.endsWith(ext))) return true;

    let hostname = "";
    try {
      hostname = new URL(s).hostname;
    } catch (e) {
      return true;
    }
    if (exclusions.domains.some((d) => hostname === d || hostname.endsWith("." + d))) return true;
    if (exclusions.snsDomains.some((d) => hostname === d || hostname.endsWith("." + d))) return true;

    return false;
  }

  // ---------------------------------------------------------
  // 14. 重複判定 / 15. 重複データ統合
  // ---------------------------------------------------------

  /**
   * 施設コード > 詳細URL > 正規化Tel1 > 正規化名+住所 の優先順位で同一性を判定する。
   */
  function isDuplicateFacility(a, b) {
    if (a.facilityCode && b.facilityCode) return a.facilityCode === b.facilityCode;
    if (a.detailUrl && b.detailUrl) return a.detailUrl === b.detailUrl;

    const aTel = normalizePhone(a.tel1);
    const bTel = normalizePhone(b.tel1);
    if (aTel && bTel) return aTel.digits === bTel.digits;

    const aKey = `${normalizeClinicName(a.name)}__${normalizeAddress(a.address)}`;
    const bKey = `${normalizeClinicName(b.name)}__${normalizeAddress(b.address)}`;
    if (a.name && b.name && a.address && b.address) return aKey === bKey;

    return false;
  }

  /**
   * 既存レコードと新規レコードを統合する。
   * 空欄で既存値を上書きしない。異なる値がある場合はより具体的な値（長い方）を採用し、
   * 差分は notes に追記して呼び出し側でエラーログ/備考に反映できるようにする。
   */
  function mergeFacilityRecords(existing, incoming) {
    const merged = Object.assign({}, existing);
    const conflicts = [];

    for (const key of Object.keys(incoming)) {
      const newVal = safeStr(incoming[key]);
      const oldVal = safeStr(existing[key]);
      if (!newVal) continue;
      if (!oldVal) {
        merged[key] = incoming[key];
        continue;
      }
      if (oldVal !== newVal) {
        // より具体的（長い）方を採用
        if (newVal.length > oldVal.length) {
          merged[key] = incoming[key];
        }
        conflicts.push(`${key}: "${oldVal}" vs "${newVal}"`);
      }
    }

    return { merged, conflicts };
  }

  // ---------------------------------------------------------
  // 16. CSVエスケープ / 17. CSV列数検証
  // ---------------------------------------------------------

  function csvEscapeValue(value) {
    const s = value === null || value === undefined ? "" : String(value);
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function buildCsvRow(values) {
    return values.map(csvEscapeValue).join(",");
  }

  /** 行が指定列数と一致するか検証する。不足分は空文字で補完した配列を返す。 */
  function validateAndPadRow(values, expectedColumnCount) {
    const arr = (values || []).slice(0, expectedColumnCount);
    while (arr.length < expectedColumnCount) arr.push("");
    return arr;
  }

  // ---------------------------------------------------------
  // 18. ページ指紋生成
  // ---------------------------------------------------------

  function simpleHash(str) {
    let hash = 0;
    const s = safeStr(str);
    for (let i = 0; i < s.length; i++) {
      hash = (hash * 31 + s.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(16);
  }

  function makePageFingerprint(pageNumber, firstName, lastName, detailUrls) {
    const urlHash = simpleHash((detailUrls || []).join("|"));
    return `${pageNumber}__${safeStr(firstName)}__${safeStr(lastName)}__${urlHash}`;
  }

  // ---------------------------------------------------------
  // アクセス制限検知
  // ---------------------------------------------------------
  function detectBlockedText(pageText) {
    const patterns = CFG.blockedTextPatterns || [];
    const s = safeStr(pageText);
    return patterns.some((p) => s.includes(p));
  }

  // ---------------------------------------------------------
  // 種別判定
  // ---------------------------------------------------------
  function determineFacilityType(text) {
    const patterns = CFG.facilityTypePatterns || {};
    const s = safeStr(text);
    for (const [type, keys] of Object.entries(patterns)) {
      if (keys.some((k) => s.includes(k))) return type;
    }
    return "";
  }

  // ---------------------------------------------------------
  // 公開
  // ---------------------------------------------------------
  global.NaviiUtils = {
    safeStr,
    toHalfWidth,
    isS2400Url,
    normalizePhone,
    isFaxLabel,
    assignPhoneNumbers,
    normalizeClinicName,
    normalizeAddress,
    extractPostalCode,
    extractPrefecture,
    splitAddress,
    normalizeWeekdayList,
    sortWeekdays,
    extractClosedDays,
    parseClinicHours,
    determineRepresentativeHours,
    determineClinicDays,
    isExcludedUrl,
    isNonFacilityNoiseText,
    buildScheduleSummaryText,
    buildRemarksText,
    isDuplicateFacility,
    mergeFacilityRecords,
    isKatakanaOnly,
    decideFacilityName,
    normalizeWeekdayToken,
    normalizeTimeToken,
    splitTimeRangeText,
    parseScheduleCellText,
    buildHoursByWeekdayFromEntries,
    determineClosedDays,
    csvEscapeValue,
    buildCsvRow,
    validateAndPadRow,
    simpleHash,
    makePageFingerprint,
    detectBlockedText,
    determineFacilityType
  };
})(typeof window !== "undefined" ? window : globalThis);
